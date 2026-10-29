//! System playback capture. One COM worker opens each selected endpoint exactly once.
use base64::Engine;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Serialize)]
pub struct AudioChunkPayload {
    #[serde(rename = "captureId")]
    pub capture_id: String,
    pub volume: f64,
    #[serde(rename = "pcmBase64")]
    pub pcm_base64: String,
}
#[derive(Clone, Serialize)]
pub struct AudioLevelPayload {
    #[serde(rename = "captureId")]
    pub capture_id: String,
    pub volume: f64,
}
#[derive(Clone, Serialize)]
pub struct AudioErrorPayload {
    #[serde(rename = "captureId")]
    pub capture_id: String,
    pub error: String,
}
#[derive(serde::Deserialize, Clone, serde::Serialize)]
pub struct AudioOutputDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioCaptureInfo {
    pub capture_id: Option<String>,
    pub devices: Vec<AudioOutputDevice>,
    pub sample_rate: u32,
    pub channels: u16,
}
struct CaptureSession {
    id: String,
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
    info: Option<AudioCaptureInfo>,
}
impl Drop for CaptureSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            #[cfg(target_os = "macos")]
            if !handle.is_finished() {
                // A cancelled native startup may still be waiting for an OS
                // completion. Retire it off-thread; its stop token gates audio.
                let _ = std::thread::Builder::new()
                    .name("capture-cleanup".into())
                    .spawn(move || {
                        let _ = handle.join();
                    });
                return;
            }
            let _ = handle.join();
        }
    }
}
#[derive(Default)]
pub struct AudioCaptureState {
    session: Mutex<Option<CaptureSession>>,
    excluded: Mutex<Vec<String>>,
}

fn publish_ready(
    state: &AudioCaptureState,
    stop: &Arc<AtomicBool>,
    mut info: AudioCaptureInfo,
) -> Result<AudioCaptureInfo, String> {
    let mut slot = state.session.lock().map_err(|_| "系统收音状态不可用")?;
    let session = slot
        .as_mut()
        .filter(|s| Arc::ptr_eq(&s.stop, stop) && !s.stop.load(Ordering::SeqCst))
        .ok_or("系统收音启动已取消")?;
    info.capture_id = Some(session.id.clone());
    session.info = Some(info.clone());
    Ok(info)
}

/// 线性插值重采样到 16kHz（mono f32 in → mono i16 out）
pub(super) struct Resampler {
    phase: f64,
    src_rate: f64,
}

impl Resampler {
    pub(super) fn new(src_rate: u32) -> Self {
        Self {
            phase: 0.0,
            src_rate: src_rate as f64,
        }
    }
    pub(super) fn push(&mut self, input: &[f32], out: &mut Vec<i16>) {
        if input.is_empty() {
            return;
        }
        let step = self.src_rate / 16000.0;
        let mut pos = self.phase;
        while pos < input.len() as f64 {
            let i0 = pos.floor() as usize;
            let i1 = (i0 + 1).min(input.len() - 1);
            let frac = (pos - i0 as f64) as f32;
            let s = input[i0] + (input[i1] - input[i0]) * frac;
            out.push((s.clamp(-1.0, 1.0) * 32767.0) as i16);
            pos += step;
        }
        self.phase = pos - input.len() as f64;
    }
}

pub(super) fn emit_chunk(app: &AppHandle, stop: &AtomicBool, pcm: &[i16]) {
    let state = app.state::<AudioCaptureState>();
    let Ok(slot) = state.session.lock() else {
        return;
    };
    let Some(session) = slot
        .as_ref()
        .filter(|s| std::ptr::eq(s.stop.as_ref(), stop) && !stop.load(Ordering::SeqCst))
    else {
        return;
    };
    let capture_id = session.id.clone();
    let volume = crate::audio_dsp::input_volume(pcm);
    let bytes: Vec<u8> = pcm.iter().flat_map(|sample| sample.to_le_bytes()).collect();
    let pcm_base64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    let _ = app.emit_to(
        "overlay",
        "system-audio-chunk",
        AudioChunkPayload {
            capture_id: capture_id.clone(),
            volume,
            pcm_base64,
        },
    );
    let _ = app.emit_to(
        "overlay",
        "system-audio-level",
        AudioLevelPayload { capture_id, volume },
    );
}

#[tauri::command]
pub async fn cmd_start_system_audio_capture(app: AppHandle) -> Result<AudioCaptureInfo, String> {
    tauri::async_runtime::spawn_blocking(move || start_capture(app))
        .await
        .map_err(|e| format!("系统收音任务失败：{e}"))?
}

fn start_capture(app: AppHandle) -> Result<AudioCaptureInfo, String> {
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = app;
        Err("当前平台尚不支持系统声音采集，请使用麦克风输入".into())
    }
    #[cfg(any(windows, target_os = "macos"))]
    {
        let state = app.state::<AudioCaptureState>();
        // Publish the pending session before waiting, so stop can cancel startup.
        let mut slot = state.session.lock().map_err(|_| "系统收音状态不可用")?;
        if let Some(session) = slot
            .as_ref()
            .filter(|session| !session.stop.load(Ordering::SeqCst))
        {
            return session
                .info
                .clone()
                .ok_or_else(|| "系统收音正在启动，请稍候。".into());
        }
        let previous = slot.take();
        let excluded = state
            .excluded
            .lock()
            .map_err(|_| "播放设备配置不可用")?
            .clone();
        let stop = Arc::new(AtomicBool::new(false));
        static NEXT_CAPTURE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let id = format!(
            "{}-{}",
            std::process::id(),
            NEXT_CAPTURE.fetch_add(1, Ordering::SeqCst)
        );
        let worker_id = id.clone();
        let worker_stop = stop.clone();
        let (ready_tx, ready_rx) = mpsc::channel();
        let worker_app = app.clone();
        let handle = std::thread::Builder::new()
            .name("system-loopback".into())
            .spawn(move || {
                let mut ready = Some(ready_tx);
                #[cfg(windows)]
                let result = crate::audio_windows::capture_loop(&worker_app, &worker_stop, &excluded, &mut ready);
                #[cfg(target_os = "macos")]
                let result = {
                    let _ = excluded; // Output-device exclusion is Windows-only.
                    if !crate::screen_permissions::check() {
                        Err("请在系统设置的「屏幕与系统音频录制」中允许本应用访问，必要时重启应用。".into())
                    } else {
                        mianxu_macos_capture::capture_audio(worker_stop.clone(), || {
                            if let Some(tx) = ready.take() { let _ = tx.send(Ok(AudioCaptureInfo { capture_id: None, devices: vec![], sample_rate: 16000, channels: 1 })); }
                        }, |pcm| emit_chunk(&worker_app, &worker_stop, pcm))
                    }
                };
                if let Err(error) =
                    result
                {
                    log::warn!("[system_audio] {error}");
                    if let Some(sender) = ready.take() {
                        let _ = sender.send(Err(error));
                    } else if !worker_stop.load(Ordering::SeqCst) {
                        let _ = worker_app.emit_to(
                            "overlay",
                            "system-audio-error",
                            AudioErrorPayload { capture_id: worker_id, error },
                        );
                    }
                }
                worker_stop.store(true, Ordering::SeqCst);
            })
            .map_err(|error| format!("无法启动系统收音线程：{error}"))?;
        *slot = Some(CaptureSession {
            id,
            stop: stop.clone(),
            handle: Some(handle),
            info: None,
        });
        drop(slot);
        drop(previous);
        let timeout = if cfg!(target_os = "macos") { 65 } else { 5 };
        match ready_rx.recv_timeout(std::time::Duration::from_secs(timeout)) {
            Ok(Ok(info)) if !stop.load(Ordering::SeqCst) => {
                log::info!(
                    "[system_audio] capturing {} endpoint(s), PCM16/16kHz/mono",
                    info.devices.len()
                );
                publish_ready(&state, &stop, info)
            }
            result => {
                stop.store(true, Ordering::SeqCst);
                let mut slot = state.session.lock().map_err(|_| "系统收音状态不可用")?;
                let failed = if slot.as_ref().is_some_and(|s| Arc::ptr_eq(&s.stop, &stop)) {
                    slot.take()
                } else {
                    None
                };
                drop(slot);
                drop(failed);
                Err(match result {
                    Ok(Err(error)) => error,
                    _ => "系统收音连接超时或已中断，请检查播放设备后重试".into(),
                })
            }
        }
    }
}

#[tauri::command]
pub fn cmd_stop_system_audio_capture(state: State<'_, AudioCaptureState>) -> Result<(), String> {
    let mut slot = state.session.lock().map_err(|_| "系统收音状态不可用")?;
    let previous = slot.take();
    // Invalidate before unlocking, so a concurrent start cannot publish old audio.
    if let Some(session) = &previous {
        session.stop.store(true, Ordering::SeqCst);
    }
    drop(slot);
    drop(previous);
    Ok(())
}
#[tauri::command]
pub fn cmd_set_system_audio_excluded_outputs(
    state: State<'_, AudioCaptureState>,
    ids: Vec<String>,
) {
    if let Ok(mut excluded) = state.excluded.lock() {
        *excluded = ids;
    }
}
#[tauri::command]
pub fn cmd_list_system_audio_outputs() -> Result<Vec<AudioOutputDevice>, String> {
    #[cfg(windows)]
    {
        let _com = crate::audio_windows::ComApartment::new()?;
        enumerate_render_devices()
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

#[cfg(windows)]
pub(super) fn enumerate_render_devices() -> Result<Vec<AudioOutputDevice>, String> {
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Media::Audio::{
        DEVICE_STATE_ACTIVE, IMMDeviceEnumerator, MMDeviceEnumerator, eConsole, eRender,
    };
    use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance, STGM_READ};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;

    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;

        let default_id = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .ok()
            .and_then(|d| device_id_of(&d).ok())
            .unwrap_or_default();

        let collection = enumerator
            .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)
            .map_err(|e| e.to_string())?;
        let count = collection.GetCount().map_err(|e| e.to_string())?;
        let mut result: Vec<AudioOutputDevice> = Vec::new();
        for i in 0..count {
            let device = match collection.Item(i) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let id = device_id_of(&device).unwrap_or_default();
            let name = (|| -> Option<String> {
                let store: IPropertyStore = device.OpenPropertyStore(STGM_READ).ok()?;
                let mut pv = store.GetValue(&PKEY_Device_FriendlyName).ok()?;
                let name = decode_propvariant_string(&pv);
                let _ = windows::Win32::System::Com::StructuredStorage::PropVariantClear(&mut pv);
                name
            })()
            .unwrap_or_else(|| "播放设备".to_string());
            result.push(AudioOutputDevice {
                is_default: id == default_id,
                id,
                name,
            });
        }
        Ok(result)
    }
}

#[cfg(windows)]
fn decode_propvariant_string(
    pv: &windows::Win32::System::Com::StructuredStorage::PROPVARIANT,
) -> Option<String> {
    // PROPVARIANT 内存布局：vt(u16) + 保留 + union（偏移 8 处的字符串指针）
    unsafe {
        let base = pv as *const _ as *const u8;
        let vt = *(base as *const u16);
        if vt != 31 {
            // VT_LPWSTR
            return None;
        }
        let raw = *(base.add(8) as *const *const u16);
        if raw.is_null() {
            return None;
        }
        let mut len = 0usize;
        while *raw.add(len) != 0 {
            len += 1;
        }
        Some(String::from_utf16_lossy(std::slice::from_raw_parts(
            raw, len,
        )))
    }
}

#[cfg(windows)]
fn device_id_of(
    device: &windows::Win32::Media::Audio::IMMDevice,
) -> Result<String, windows::core::Error> {
    unsafe {
        let pwstr = device.GetId()?;
        let wide = pwstr.as_wide();
        let id = String::from_utf16_lossy(wide);
        windows::Win32::System::Com::CoTaskMemFree(Some(pwstr.as_ptr() as *const _));
        Ok(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancelled_start_cannot_publish_into_a_replacement_session() {
        let state = AudioCaptureState::default();
        let old = Arc::new(AtomicBool::new(false));
        let current = Arc::new(AtomicBool::new(false));
        *state.session.lock().unwrap() = Some(CaptureSession {
            id: "current".into(),
            stop: current.clone(),
            handle: None,
            info: None,
        });
        let info = AudioCaptureInfo {
            capture_id: None,
            devices: vec![],
            sample_rate: 16000,
            channels: 1,
        };
        assert!(publish_ready(&state, &old, info.clone()).is_err());
        assert!(
            state
                .session
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .info
                .is_none()
        );
        assert_eq!(
            publish_ready(&state, &current, info.clone())
                .unwrap()
                .sample_rate,
            16000
        );
        assert_eq!(
            state
                .session
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .info
                .as_ref()
                .unwrap()
                .capture_id
                .as_deref(),
            Some("current")
        );
        current.store(true, Ordering::SeqCst);
        assert!(publish_ready(&state, &current, info).is_err());
    }

    #[test]
    fn loopback_one_second_keeps_its_duration_at_16khz() {
        for rate in [16000, 44100, 48000, 96000] {
            let input: Vec<f32> = (0..rate)
                .map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 0.2)
                .collect();
            let mut resampler = Resampler::new(rate);
            let mut pcm = Vec::new();
            for packet in input.chunks(441) {
                resampler.push(packet, &mut pcm);
            }
            assert!(
                pcm.len().abs_diff(16000) <= 1,
                "{rate} Hz loopback: one second became {} samples instead of 16000",
                pcm.len()
            );
        }
    }
}
