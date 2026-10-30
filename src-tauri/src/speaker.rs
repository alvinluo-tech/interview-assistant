//! Local speaker verification. A non-match is unknown, never automatically the interviewer.
use serde::Serialize;
use sha2::{Digest, Sha256};
use sherpa_onnx::{SpeakerEmbeddingExtractor, SpeakerEmbeddingExtractorConfig};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
const MODEL_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx";
const MODEL_SHA: &str = "f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11";
const MAX_MODEL: usize = 40 * 1024 * 1024;
#[derive(Default)]
struct Inner {
    extractor: Option<SpeakerEmbeddingExtractor>,
    my_voice: Option<Vec<f32>>,
    peer: Option<Vec<f32>>,
    owner: String,
    revision: u64,
    segments: VecDeque<(String, Vec<f32>)>,
}
#[derive(Default, Clone)]
pub struct SpeakerState {
    inner: Arc<Mutex<Inner>>,
    preparing: Arc<AtomicBool>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    ready: bool,
    enrolled: bool,
    saved: bool,
    preparing: bool,
    cached: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    role: String,
    score: f32,
    revision: u64,
    cluster_id: String,
    source: &'static str,
}
fn allowed(window: &WebviewWindow, main: bool) -> Result<(), String> {
    if window.label() == "main" || (!main && window.label() == "overlay") {
        Ok(())
    } else {
        Err("当前窗口不能操作声纹。".into())
    }
}
fn model_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("speech")
        .join("campplus-zh-cn-16k.onnx"))
}
fn profile_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("speech")
        .join("self-voice.enc"))
}
fn valid_model(bytes: &[u8]) -> bool {
    bytes.len() <= MAX_MODEL && format!("{:x}", Sha256::digest(bytes)) == MODEL_SHA
}
fn normalize(mut value: Vec<f32>) -> Result<Vec<f32>, String> {
    let norm = value.iter().map(|x| x * x).sum::<f32>().sqrt();
    if value.len() < 32 || value.len() > 4096 || !norm.is_finite() || norm < 1e-8 {
        return Err("声纹数据无效，请重新试音。".into());
    }
    for x in &mut value {
        *x /= norm;
    }
    Ok(value)
}
fn similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return -1.0;
    }
    a.iter()
        .zip(b)
        .map(|(x, y)| x * y)
        .sum::<f32>()
        .clamp(-1.0, 1.0)
}
fn embedding(extractor: &SpeakerEmbeddingExtractor, pcm: &[i16]) -> Result<Vec<f32>, String> {
    if pcm.len() < 19200 || pcm.len() > 16000 * 30 {
        return Err("需要 1.2–30 秒的单人语音。".into());
    }
    let energy = pcm.iter().filter(|x| x.unsigned_abs() > 500).count();
    let clipped = pcm.iter().filter(|x| x.unsigned_abs() > 32700).count();
    if energy < pcm.len() / 20 || clipped > pcm.len() / 20 {
        return Err("语音太轻或有削波，请靠近麦克风并调整音量。".into());
    }
    let samples: Vec<f32> = pcm.iter().map(|x| *x as f32 / 32768.0).collect();
    let stream = extractor.create_stream().ok_or("声纹分析启动失败")?;
    stream.accept_waveform(16000, &samples);
    stream.input_finished();
    if !extractor.is_ready(&stream) {
        return Err("有效人声不足，请说完整一句话。".into());
    }
    normalize(extractor.compute(&stream).ok_or("声纹分析失败")?)
}
fn decide(my: &[f32], peer: Option<&[f32]>, voice: &[f32]) -> (&'static str, f32) {
    let own = similarity(my, voice);
    let other = peer.map(|x| similarity(x, voice)).unwrap_or(-1.0);
    if own >= 0.65 && own - other >= 0.10 {
        ("candidate", own)
    } else if other >= 0.65 && other - own >= 0.10 {
        ("interviewer", other)
    } else {
        ("unknown", own.max(other).max(0.0))
    }
}
#[tauri::command]
pub fn cmd_speaker_status(app: AppHandle, window: WebviewWindow) -> Result<Status, String> {
    allowed(&window, false)?;
    let state = app.state::<SpeakerState>();
    let inner = state.inner.lock().map_err(|_| "声纹状态不可用")?;
    Ok(Status {
        ready: inner.extractor.is_some(),
        enrolled: inner.my_voice.is_some(),
        saved: profile_path(&app)?.is_file(),
        preparing: state.preparing.load(Ordering::SeqCst),
        cached: model_path(&app)?.is_file(),
    })
}
#[tauri::command]
pub async fn cmd_speaker_prepare(
    app: AppHandle,
    window: WebviewWindow,
    download: Option<bool>,
) -> Result<(), String> {
    allowed(&window, true)?;
    let state = app.state::<SpeakerState>().inner().clone();
    if state.preparing.swap(true, Ordering::SeqCst) {
        return Err("正在准备声纹模型，请稍候。".into());
    }
    struct Reset(Arc<AtomicBool>);
    impl Drop for Reset {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _reset = Reset(state.preparing.clone());
    let path = model_path(&app)?;
    let cached = std::fs::metadata(&path)
        .ok()
        .filter(|meta| meta.len() <= MAX_MODEL as u64)
        .and_then(|_| std::fs::read(&path).ok())
        .filter(|b| valid_model(b));
    if cached.is_none() {
        if download == Some(false) {
            return Err("本地模型缓存缺失或校验失败，请点击准备模型。".into());
        }
        let client = tauri_plugin_http::reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .redirect(tauri_plugin_http::reqwest::redirect::Policy::limited(4))
            .build()
            .map_err(|e| e.to_string())?;
        let mut response = client
            .get(MODEL_URL)
            .send()
            .await
            .map_err(|_| "模型下载失败，请检查网络后重试。")?
            .error_for_status()
            .map_err(|_| "模型下载服务暂时不可用。")?;
        if response
            .content_length()
            .is_some_and(|n| n > MAX_MODEL as u64)
        {
            return Err("模型大小异常".into());
        }
        let total = response.content_length();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "模型下载中断")? {
            if bytes.len() + chunk.len() > MAX_MODEL {
                return Err("模型大小异常".into());
            }
            bytes.extend_from_slice(&chunk);
            let _ = app.emit_to(
                "main",
                "speaker-model-progress",
                serde_json::json!({"downloaded":bytes.len(),"total":total}),
            );
        }
        if !valid_model(&bytes) {
            return Err("模型校验失败，未安装该文件。".into());
        }
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        let temporary = path.with_extension("download");
        std::fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        std::fs::rename(temporary, &path).map_err(|e| e.to_string())?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let extractor = SpeakerEmbeddingExtractor::create(&SpeakerEmbeddingExtractorConfig {
            model: Some(path.to_string_lossy().into_owned()),
            num_threads: 1,
            ..Default::default()
        })
        .ok_or("本地声纹模型加载失败")?;
        let mut inner = state.inner.lock().map_err(|_| "声纹状态不可用")?;
        inner.extractor = Some(extractor);
        if inner.my_voice.is_none() {
            let profile = profile_path(&app)?;
            if std::fs::metadata(&profile).is_ok_and(|m| m.len() > 1024 * 1024) {
                return Err("保存的声纹文件异常，请清除后重新试音。".into());
            }
            if let Ok(bytes) = std::fs::read(profile) {
                let plain = crate::ai_settings::crypt(&bytes, false)?;
                inner.my_voice = Some(normalize(
                    serde_json::from_slice(&plain)
                        .map_err(|_| "保存的声纹损坏，请清除后重新试音")?,
                )?);
            }
        }
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn cmd_speaker_enroll(
    app: AppHandle,
    window: WebviewWindow,
    pcm: Vec<i16>,
    persist: bool,
) -> Result<(), String> {
    allowed(&window, true)?;
    if pcm.len() < 16000 * 6 || pcm.len() > 16000 * 30 {
        return Err("请录制 6–30 秒自己的清晰语音。".into());
    }
    let state = app.state::<SpeakerState>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut inner = state.inner.lock().map_err(|_| "声纹状态不可用")?;
        let extractor = inner.extractor.as_ref().ok_or("请先准备声纹模型")?;
        let vector = embedding(extractor, &pcm)?;
        let middle = pcm.len() / 2;
        let first = embedding(extractor, &pcm[..middle])?;
        let last = embedding(extractor, &pcm[middle..])?;
        if similarity(&first, &last) < 0.50 {
            return Err("试音前后声音差异较大，请保持单人说话并重新录制。".into());
        }
        let path = profile_path(&app)?;
        if persist {
            let encrypted = crate::ai_settings::crypt(
                &serde_json::to_vec(&vector).map_err(|e| e.to_string())?,
                true,
            )?;
            std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
            std::fs::write(path, encrypted).map_err(|e| e.to_string())?;
        } else if path.exists() {
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        inner.my_voice = Some(vector);
        inner.peer = None;
        inner.segments.clear();
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn cmd_speaker_begin(
    app: AppHandle,
    window: WebviewWindow,
    owner: String,
) -> Result<(), String> {
    allowed(&window, false)?;
    if owner.is_empty() || owner.len() > 128 {
        return Err("会话标识无效".into());
    }
    let state = app.state::<SpeakerState>();
    let mut inner = state.inner.lock().map_err(|_| "声纹状态不可用")?;
    if inner.extractor.is_none() || inner.my_voice.is_none() {
        return Err("请先在电话面试设置中完成自己的试音。".into());
    }
    inner.owner = owner;
    inner.peer = None;
    inner.segments.clear();
    Ok(())
}
#[tauri::command]
pub async fn cmd_speaker_identify(
    app: AppHandle,
    window: WebviewWindow,
    owner: String,
    segment_id: String,
    pcm: Vec<i16>,
) -> Result<Decision, String> {
    allowed(&window, false)?;
    if pcm.len() > 16000 * 30 || segment_id.len() > 128 {
        return Err("语音片段过大".into());
    }
    let state = app.state::<SpeakerState>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut inner = state.inner.lock().map_err(|_| "声纹状态不可用")?;
        if inner.owner != owner || owner.is_empty() {
            return Err("声纹会话已结束".into());
        }
        inner.revision += 1;
        let voice = embedding(inner.extractor.as_ref().ok_or("模型未就绪")?, &pcm);
        let (mut role, score) = if let Ok(ref vector) = voice {
            decide(
                inner.my_voice.as_ref().ok_or("尚未试音")?,
                inner.peer.as_deref(),
                vector,
            )
        } else {
            ("unknown", 0.0)
        };
        // A long ASR sentence may straddle a turn change. Disagreement between
        // independent head/tail windows is not valid single-speaker evidence.
        if pcm.len() >= 16000 * 4 {
            let extractor = inner.extractor.as_ref().unwrap();
            if let (Ok(head), Ok(tail)) = (
                embedding(extractor, &pcm[..32000]),
                embedding(extractor, &pcm[pcm.len() - 32000..]),
            ) {
                let a = decide(
                    inner.my_voice.as_ref().unwrap(),
                    inner.peer.as_deref(),
                    &head,
                )
                .0;
                let b = decide(
                    inner.my_voice.as_ref().unwrap(),
                    inner.peer.as_deref(),
                    &tail,
                )
                .0;
                if a != b {
                    role = if a != "unknown" && b != "unknown" {
                        "overlap"
                    } else {
                        "unknown"
                    };
                }
            }
        }
        if let (Ok(vector), true) = (voice, role != "overlap") {
            inner.segments.push_back((segment_id.clone(), vector));
            while inner.segments.len() > 32 {
                inner.segments.pop_front();
            }
        }
        Ok(Decision {
            role: role.into(),
            score,
            revision: inner.revision,
            cluster_id: segment_id,
            source: "local-match",
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn cmd_speaker_bind(
    app: AppHandle,
    window: WebviewWindow,
    owner: String,
    segment_id: String,
    role: String,
) -> Result<(), String> {
    allowed(&window, false)?;
    let state = app.state::<SpeakerState>();
    let mut inner = state.inner.lock().map_err(|_| "声纹状态不可用")?;
    if inner.owner != owner || owner.is_empty() {
        return Err("声纹会话已结束".into());
    }
    let vector = inner
        .segments
        .iter()
        .find(|x| x.0 == segment_id)
        .map(|x| x.1.clone())
        .ok_or("该语音已过期，请在下一句标记")?;
    if role == "interviewer" {
        if inner
            .my_voice
            .as_ref()
            .is_some_and(|v| similarity(v, &vector) > 0.75)
        {
            return Err("该片段与本人声纹过于接近，请选择更长的面试官单人语音。".into());
        }
        inner.peer = Some(vector);
    } else if role != "candidate" {
        return Err("身份无效".into());
    }
    Ok(())
}
#[tauri::command]
pub fn cmd_speaker_end(app: AppHandle, window: WebviewWindow, owner: String) -> Result<(), String> {
    allowed(&window, false)?;
    let state = app.state::<SpeakerState>();
    let mut inner = state.inner.lock().map_err(|_| "声纹状态不可用")?;
    if inner.owner == owner {
        inner.owner.clear();
        inner.peer = None;
        inner.segments.clear();
    }
    Ok(())
}
#[tauri::command]
pub fn cmd_speaker_clear(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    allowed(&window, true)?;
    let path = profile_path(&app)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    let state = app.state::<SpeakerState>();
    let mut inner = state.inner.lock().map_err(|_| "声纹状态不可用")?;
    inner.my_voice = None;
    inner.peer = None;
    inner.segments.clear();
    inner.owner.clear();
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unrelated_is_not_peer() {
        let a = vec![1.0, 0.0];
        assert_eq!(decide(&a, None, &[0.0, 1.0]).0, "unknown");
        assert_eq!(decide(&a, None, &a).0, "candidate");
        assert_eq!(decide(&a, Some(&[0.0, 1.0]), &[0.0, 1.0]).0, "interviewer");
        assert_eq!(decide(&a, Some(&a), &a).0, "unknown");
    }
    #[test]
    fn corrupt_models_and_vectors_rejected() {
        assert!(!valid_model(b"bad"));
        assert!(normalize(vec![f32::NAN; 192]).is_err());
        assert!(normalize(vec![0.0; 192]).is_err());
    }
    #[test]
    #[ignore = "requires explicitly downloaded public model and fixture"]
    fn actual_model_embedding() {
        let root = std::env::var("SPEAKER_TEST_ASSETS").unwrap();
        let bytes = std::fs::read(format!("{root}/speaker-model.onnx")).unwrap();
        assert!(valid_model(&bytes));
        let e = SpeakerEmbeddingExtractor::create(&SpeakerEmbeddingExtractorConfig {
            model: Some(format!("{root}/speaker-model.onnx")),
            ..Default::default()
        })
        .unwrap();
        let started = std::time::Instant::now();
        let vectors: Vec<Vec<f32>> = ["fangjun-sr-1.wav", "fangjun-sr-2.wav", "leijun-sr-1.wav"]
            .iter()
            .map(|name| {
                let wave = sherpa_onnx::Wave::read(&format!("{root}/{name}")).unwrap();
                assert_eq!(wave.sample_rate(), 16000);
                let pcm: Vec<i16> = wave
                    .samples()
                    .iter()
                    .map(|s| (s * 32767.0) as i16)
                    .collect();
                embedding(&e, &pcm).unwrap()
            })
            .collect();
        let own = similarity(&vectors[0], &vectors[1]);
        let other = similarity(&vectors[0], &vectors[2]);
        eprintln!(
            "speaker fixture: dimension={}, same={own:.4}, other={other:.4}, elapsed_ms={}",
            e.dim(),
            started.elapsed().as_millis()
        );
        assert!(own > other + 0.15);
        assert_eq!(decide(&vectors[0], None, &vectors[2]).0, "unknown");
        assert!((similarity(&vectors[0], &vectors[0]) - 1.0).abs() < 0.001);
        assert_eq!(vectors[0].len(), e.dim() as usize);
    }
}
