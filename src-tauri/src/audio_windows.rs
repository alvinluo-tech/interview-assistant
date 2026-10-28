//! All WASAPI clients live on one COM-initialized worker; no COM pointers cross threads.
use crate::{
    audio::{AudioCaptureInfo, AudioOutputDevice, Resampler},
    audio_dsp::{AudioFormat, CHUNK_SAMPLES, Encoding},
};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::Sender,
    },
    time::{Duration, Instant},
};
use tauri::AppHandle;
use windows::{
    Win32::{
        Foundation::RPC_E_CHANGED_MODE,
        Media::Audio::{
            AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
            IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
            WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
        },
        System::Com::{
            CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
            CoUninitialize,
        },
    },
    core::{GUID, PCWSTR},
};

pub(super) struct ComApartment(bool);
impl ComApartment {
    pub fn new() -> Result<Self, String> {
        let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if result.is_ok() {
            Ok(Self(true))
        } else if result == RPC_E_CHANGED_MODE {
            Ok(Self(false))
        } else {
            Err(format!("系统音频 COM 初始化失败：{result}"))
        }
    }
}
impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.0 {
            unsafe {
                CoUninitialize();
            }
        }
    }
}

struct MixFormat(*mut WAVEFORMATEX);
impl Drop for MixFormat {
    fn drop(&mut self) {
        unsafe {
            CoTaskMemFree(Some(self.0.cast()));
        }
    }
}

unsafe fn parse_format(pointer: *const WAVEFORMATEX) -> Result<AudioFormat, String> {
    if pointer.is_null() {
        return Err("播放设备没有返回音频格式".into());
    }
    let format = unsafe { *pointer };
    let encoding = match format.wFormatTag {
        1 => Encoding::Pcm,
        3 => Encoding::Float,
        0xfffe if format.cbSize >= 22 => {
            let extended = unsafe { *(pointer.cast::<WAVEFORMATEXTENSIBLE>()) };
            let subtype = extended.SubFormat;
            if subtype == GUID::from_u128(0x00000001_0000_0010_8000_00aa00389b71) {
                Encoding::Pcm
            } else if subtype == GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71) {
                Encoding::Float
            } else {
                return Err("播放设备使用了不支持的扩展音频格式".into());
            }
        }
        _ => return Err("播放设备使用了不支持的音频格式".into()),
    };
    AudioFormat::new(
        format.nSamplesPerSec,
        format.nChannels,
        format.wBitsPerSample,
        format.nBlockAlign,
        encoding,
    )
}

struct LoopbackStream {
    device: AudioOutputDevice,
    client: IAudioClient,
    capture: IAudioCaptureClient,
    format: AudioFormat,
    resampler: Resampler,
}
impl LoopbackStream {
    fn open(enumerator: &IMMDeviceEnumerator, device: AudioOutputDevice) -> Result<Self, String> {
        unsafe {
            let wide: Vec<u16> = device.id.encode_utf16().chain(Some(0)).collect();
            // Open this endpoint, never fall back to opening the default endpoint again.
            let endpoint = enumerator
                .GetDevice(PCWSTR(wide.as_ptr()))
                .map_err(|e| e.to_string())?;
            let client: IAudioClient = endpoint
                .Activate(CLSCTX_ALL, None)
                .map_err(|e| e.to_string())?;
            let mix = MixFormat(client.GetMixFormat().map_err(|e| e.to_string())?);
            let format = parse_format(mix.0)?;
            client
                .Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_LOOPBACK,
                    2_000_000,
                    0,
                    mix.0,
                    None,
                )
                .map_err(|e| e.to_string())?;
            let capture: IAudioCaptureClient = client.GetService().map_err(|e| e.to_string())?;
            client.Start().map_err(|e| e.to_string())?;
            let resampler = Resampler::new(format.rate);
            Ok(Self {
                device,
                client,
                capture,
                format,
                resampler,
            })
        }
    }

    fn read_pending(&mut self, buffer: &mut VecDeque<i16>) -> Result<(), String> {
        unsafe {
            // Bound each polling pass so a misbehaving endpoint cannot starve the others.
            for _ in 0..256 {
                if self
                    .capture
                    .GetNextPacketSize()
                    .map_err(|e| e.to_string())?
                    == 0
                {
                    break;
                }
                let mut pointer = std::ptr::null_mut();
                let mut frames = 0;
                let mut flags = 0;
                self.capture
                    .GetBuffer(&mut pointer, &mut frames, &mut flags, None, None)
                    .map_err(|e| e.to_string())?;
                let decoded = (|| {
                    let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
                    let count = self.format.byte_count(frames as usize)?;
                    let bytes = if silent || pointer.is_null() {
                        None
                    } else {
                        Some(std::slice::from_raw_parts(pointer, count))
                    };
                    self.format.decode(bytes, frames as usize, silent)
                })();
                // Every successful GetBuffer must be paired, including conversion errors.
                let released = self
                    .capture
                    .ReleaseBuffer(frames)
                    .map_err(|e| e.to_string());
                let mono = decoded?;
                released?;
                let mut pcm = Vec::new();
                self.resampler.push(&mono, &mut pcm);
                buffer.extend(pcm);
                if buffer.len() > CHUNK_SAMPLES * 20 {
                    return Err("系统收音处理延迟超过两秒，请暂停后继续以重新同步".into());
                }
            }
        }
        Ok(())
    }
}
impl Drop for LoopbackStream {
    fn drop(&mut self) {
        let _ = unsafe { self.client.Stop() };
    }
}

pub(super) fn capture_loop(
    app: &AppHandle,
    stop: &AtomicBool,
    excluded: &[String],
    ready: &mut Option<Sender<Result<AudioCaptureInfo, String>>>,
) -> Result<(), String> {
    let _com = ComApartment::new()?;
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .map_err(|e| e.to_string())?;
    let devices = crate::audio::enumerate_render_devices()?;
    let mut seen = std::collections::HashSet::new();
    let mut streams = Vec::new();
    for device in devices
        .into_iter()
        .filter(|d| d.is_default || !excluded.contains(&d.id))
    {
        if device.id.is_empty() || !seen.insert(device.id.clone()) {
            continue;
        }
        let name = device.name.clone();
        let stream = LoopbackStream::open(&enumerator, device)
            .map_err(|e| format!("无法采集播放设备「{name}」：{e}"))?;
        streams.push(stream);
    }
    if streams.is_empty() {
        return Err("没有可用的系统播放设备，请连接耳机或扬声器后重试".into());
    }
    let info = AudioCaptureInfo {
        devices: streams.iter().map(|stream| stream.device.clone()).collect(),
        sample_rate: 16000,
        channels: 1,
    };
    if stop.load(Ordering::SeqCst) {
        return Ok(());
    }
    ready
        .take()
        .ok_or("系统收音初始化状态无效")?
        .send(Ok(info))
        .map_err(|_| "系统收音启动已取消")?;
    let mut buffers = vec![VecDeque::new(); streams.len()];
    let mut deadline = Instant::now() + Duration::from_millis(100);
    while !stop.load(Ordering::SeqCst) {
        for (stream, buffer) in streams.iter_mut().zip(&mut buffers) {
            stream.read_pending(buffer).map_err(|e| {
                format!(
                    "播放设备「{}」收音中断：{e}。请暂停后继续以重新连接设备。",
                    stream.device.name
                )
            })?;
        }
        if Instant::now() >= deadline {
            let pcm = crate::audio_dsp::mix_chunk(&mut buffers);
            crate::audio::emit_chunk(app, &pcm);
            deadline += Duration::from_millis(100);
        }
        std::thread::sleep(Duration::from_millis(8));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn extensible_integer_pcm_is_not_misclassified_as_float() {
        let mut format = WAVEFORMATEXTENSIBLE::default();
        format.Format = WAVEFORMATEX {
            wFormatTag: 0xfffe,
            nChannels: 2,
            nSamplesPerSec: 48000,
            nAvgBytesPerSec: 384000,
            nBlockAlign: 8,
            wBitsPerSample: 32,
            cbSize: 22,
        };
        format.SubFormat = GUID::from_u128(0x00000001_0000_0010_8000_00aa00389b71);
        let decoded_format = unsafe { parse_format(&format.Format) }.unwrap();
        let sample = 1073741824i32.to_le_bytes().repeat(2);
        assert_eq!(
            decoded_format.decode(Some(&sample), 1, false).unwrap(),
            vec![0.5]
        );
        format.SubFormat = GUID::zeroed();
        assert!(unsafe { parse_format(&format.Format) }.is_err());
    }

    #[test]
    #[ignore = "requires a real Windows playback endpoint and plays a one-second quiet test tone"]
    fn hardware_loopback_preserves_test_tone_pitch() {
        use windows::Win32::Media::Audio::{PlaySoundW, SND_MEMORY, SND_SYNC};
        let _com = ComApartment::new().unwrap();
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.unwrap();
        let devices = crate::audio::enumerate_render_devices().unwrap();
        assert!(!devices.is_empty(), "No playback endpoint");
        let mut streams: Vec<_> = devices.into_iter()
            .map(|device| LoopbackStream::open(&enumerator, device).unwrap()).collect();
        let mut buffers = vec![VecDeque::new(); streams.len()];
        let mut wav = Vec::new();
        let count = 48000u32;
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + count * 2).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&48000u32.to_le_bytes());
        wav.extend_from_slice(&96000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(count * 2).to_le_bytes());
        for i in 0..count {
            let sample =
                (f32::sin(i as f32 * 440.0 * std::f32::consts::TAU / 48000.0) * 3276.0) as i16;
            wav.extend_from_slice(&sample.to_le_bytes());
        }
        let player = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            assert!(
                unsafe { PlaySoundW(PCWSTR(wav.as_ptr().cast()), None, SND_MEMORY | SND_SYNC) }
                    .as_bool()
            );
        });
        let start = Instant::now();
        let mut pcm = Vec::new();
        let mut deadline = start + Duration::from_millis(100);
        while start.elapsed() < Duration::from_millis(1500) {
            for (stream, buffer) in streams.iter_mut().zip(&mut buffers) { stream.read_pending(buffer).unwrap(); }
            if Instant::now() >= deadline {
                pcm.extend(crate::audio_dsp::mix_chunk(&mut buffers));
                deadline += Duration::from_millis(100);
            }
            std::thread::sleep(Duration::from_millis(8));
        }
        player.join().unwrap();
        assert!(
            pcm.len() >= 15000 && pcm.len() <= 26000,
            "Unexpected 1.5s capture length: {} samples",
            pcm.len()
        );
        let power = |frequency: f64| {
            let (mut real, mut imaginary) = (0.0, 0.0);
            for (index, sample) in pcm.iter().enumerate() {
                let angle = index as f64 * frequency * std::f64::consts::TAU / 16000.0;
                real += f64::from(*sample) * angle.cos();
                imaginary += f64::from(*sample) * angle.sin();
            }
            real * real + imaginary * imaginary
        };
        let expected = power(440.0);
        let stretched = power(440.0 / 9.0);
        assert!(
            expected > 1_000_000.0 && expected > stretched * 20.0,
            "Captured test tone is missing or pitch-shifted: expected={expected}, stretched={stretched}"
        );
        println!(
            "Windows hardware loopback: {} endpoint(s), {} samples, 440Hz power / stretched-frequency power = {:.1}",
            streams.len(), pcm.len(),
            expected / stretched.max(1.0)
        );
    }
}
