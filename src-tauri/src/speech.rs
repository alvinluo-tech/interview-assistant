//! OS voices: SAPI on Windows and the system `say` executable on macOS. No shell interpolation.
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

struct Speech {
    id: String,
    window: String,
    stop: Arc<AtomicBool>,
    #[cfg(target_os = "macos")]
    child: Arc<Mutex<Option<std::process::Child>>>,
}
impl Speech {
    fn cancel(&self) {
        self.stop.store(true, Ordering::SeqCst);
        #[cfg(target_os = "macos")]
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
#[derive(Default)]
pub struct SpeechState(Mutex<Option<Speech>>);
pub fn cancel_window(app: &AppHandle, label: &str) {
    let state = app.state::<SpeechState>();
    let mut slot = state.0.lock().unwrap();
    if slot.as_ref().is_some_and(|s| s.window == label) {
        if let Some(s) = slot.take() {
            s.cancel();
        }
    }
}
pub fn cancel_all(app: &AppHandle) {
    if let Some(speech) = app.state::<SpeechState>().0.lock().unwrap().take() {
        speech.cancel();
    }
}
#[tauri::command]
pub fn cmd_system_speech_stop(app: AppHandle, window: WebviewWindow, id: String) {
    let state = app.state::<SpeechState>();
    let mut slot = state.0.lock().unwrap();
    if slot
        .as_ref()
        .is_some_and(|s| s.id == id && s.window == window.label())
    {
        if let Some(s) = slot.take() {
            s.cancel();
        }
    }
}
#[tauri::command]
pub fn cmd_system_speech(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
    text: String,
    language: Option<String>,
    rate: Option<f32>,
    accent: Option<String>,
) -> Result<(), String> {
    let rate = rate.unwrap_or(1.0);
    if !rate.is_finite()
        || !(0.7..=1.4).contains(&rate)
        || language
            .as_deref()
            .is_some_and(|v| !["zh-CN", "en-US", "yue-HK"].contains(&v))
    {
        return Err("系统语音语言或语速无效。".into());
    }
    if accent
        .as_deref()
        .is_some_and(|v| !["standard", "cantonese"].contains(&v))
    {
        return Err("本机系统语音没有已确认的这个方言音色，请配置云端语音。".into());
    }
    if !["main", "mock"].contains(&window.label())
        || id.len() > 128
        || text.is_empty()
        || text.len() > 30_000
        || text.contains('\0')
    {
        return Err("语音请求无效。".into());
    }
    let stop = Arc::new(AtomicBool::new(false));
    #[cfg(target_os = "macos")]
    let child = Arc::new(Mutex::new(None));
    {
        let state = app.state::<SpeechState>();
        let mut slot = state.0.lock().map_err(|_| "语音状态不可用")?;
        if let Some(previous) = slot.take() {
            previous.cancel();
        }
        *slot = Some(Speech {
            id: id.clone(),
            window: window.label().into(),
            stop: stop.clone(),
            #[cfg(target_os = "macos")]
            child: child.clone(),
        });
    }
    let label = window.label().to_owned();
    std::thread::spawn(move || {
        let _ = app.emit_to(
            &label,
            "system-speech-state",
            serde_json::json!({"id":id,"speaking":true}),
        );
        #[cfg(not(target_os = "macos"))]
        let result = speak(text, &stop, language.as_deref(), rate);
        #[cfg(target_os = "macos")]
        let result = speak(text, &stop, &child, language.as_deref(), rate);
        let _ = app.emit_to(
            &label,
            "system-speech-state",
            serde_json::json!({"id":id,"speaking":false,"error":result.err()}),
        );
    });
    Ok(())
}

#[cfg(windows)]
fn speak(text: String, stop: &AtomicBool, language: Option<&str>, rate: f32) -> Result<(), String> {
    use windows::{
        Win32::{
            Media::Speech::{
                ISpObjectTokenCategory, ISpVoice, SPCAT_VOICES, SPRS_DONE, SPVOICESTATUS,
                SVSFIsNotXML, SVSFPurgeBeforeSpeak, SVSFlagsAsync, SpObjectTokenCategory, SpVoice,
            },
            System::Com::{
                CLSCTX_ALL, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
                CoUninitialize,
            },
        },
        core::PCWSTR,
    };
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|e| e.to_string())?;
        let result = (|| -> windows::core::Result<()> {
            let voice: ISpVoice = CoCreateInstance(&SpVoice, None, CLSCTX_ALL)?;
            if let Some(language) = language {
                let category: ISpObjectTokenCategory =
                    CoCreateInstance(&SpObjectTokenCategory, None, CLSCTX_ALL)?;
                category.SetId(SPCAT_VOICES, false)?;
                let filter = match language {
                    "en-US" => "Language=409",
                    "yue-HK" => "Language=C04",
                    _ => "Language=804",
                };
                let required: Vec<u16> = filter.encode_utf16().chain(Some(0)).collect();
                let tokens = category.EnumTokens(PCWSTR(required.as_ptr()), PCWSTR::null())?;
                let mut token = None;
                let mut fetched = 0;
                tokens.Next(1, &mut token, Some(&mut fetched))?;
                let token = token.ok_or_else(|| {
                    windows::core::Error::new(
                        windows::Win32::Foundation::E_FAIL,
                        "本机未安装匹配的语音包，请安装系统语音或配置云语音。",
                    )
                })?;
                voice.SetVoice(&token)?;
            }
            voice.SetRate(((rate - 1.0) * 10.0).round() as i32)?;
            let words: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
            if stop.load(Ordering::SeqCst) {
                return Ok(());
            }
            voice.Speak(
                PCWSTR(words.as_ptr()),
                (SVSFlagsAsync.0 | SVSFIsNotXML.0) as u32,
                None,
            )?;
            loop {
                if stop.load(Ordering::SeqCst) {
                    voice.Speak(
                        PCWSTR::null(),
                        (SVSFlagsAsync.0 | SVSFPurgeBeforeSpeak.0) as u32,
                        None,
                    )?;
                    break;
                }
                let mut status = SPVOICESTATUS::default();
                voice.GetStatus(&mut status, std::ptr::null_mut())?;
                if status.dwRunningState == SPRS_DONE.0 as u32 {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
            Ok(())
        })();
        CoUninitialize();
        result.map_err(|e| format!("系统语音播放失败：{e}"))
    }
}
#[cfg(target_os = "macos")]
fn speak(
    text: String,
    stop: &AtomicBool,
    shared: &Mutex<Option<std::process::Child>>,
    language: Option<&str>,
    rate: f32,
) -> Result<(), String> {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    if stop.load(Ordering::SeqCst) {
        return Ok(());
    }
    let mut command = Command::new("/usr/bin/say");
    if let Some(language) = language {
        let wanted = match language {
            "en-US" => "en_",
            "yue-HK" => "zh_HK",
            _ => "zh_CN",
        };
        let listing = Command::new("/usr/bin/say")
            .args(["-v", "?"])
            .output()
            .map_err(|e| e.to_string())?;
        let listing = String::from_utf8_lossy(&listing.stdout);
        let voice = listing
            .lines()
            .find_map(|line| {
                let prefix = line.split('#').next()?;
                let mut parts = prefix.split_whitespace().collect::<Vec<_>>();
                let locale = parts.pop()?;
                if locale.starts_with(wanted) {
                    Some(parts.join(" "))
                } else {
                    None
                }
            })
            .ok_or("本机未安装匹配的语音包，请在系统设置中添加声音或配置云语音。")?;
        command.args(["-v", &voice]);
    }
    command.args(["-r", &((175.0 * rate).round() as u32).to_string()]);
    let child = command
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    *shared.lock().unwrap() = Some(child);
    let cancel = || {
        if let Some(mut child) = shared.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    };
    if stop.load(Ordering::SeqCst) {
        cancel();
        return Ok(());
    }
    let input = shared
        .lock()
        .unwrap()
        .as_mut()
        .and_then(|child| child.stdin.take());
    if let Some(mut input) = input {
        if let Err(error) = input.write_all(text.as_bytes()) {
            cancel();
            return Err(error.to_string());
        }
    }
    loop {
        if stop.load(Ordering::SeqCst) {
            cancel();
            return Ok(());
        }
        let status = match shared.lock().unwrap().as_mut() {
            Some(child) => child.try_wait(),
            None => return Ok(()),
        };
        match status {
            Ok(Some(status)) => {
                shared.lock().unwrap().take();
                return if status.success() {
                    Ok(())
                } else {
                    Err("系统语音进程退出失败".into())
                };
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(40)),
            Err(error) => {
                cancel();
                return Err(error.to_string());
            }
        }
    }
}
#[cfg(not(any(windows, target_os = "macos")))]
fn speak(_: String, _: &AtomicBool, _: Option<&str>, _: f32) -> Result<(), String> {
    Err("当前平台暂未接入系统语音。".into())
}
