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
) -> Result<(), String> {
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
        let result = speak(text, &stop);
        #[cfg(target_os = "macos")]
        let result = speak(text, &stop, &child);
        let _ = app.emit_to(
            &label,
            "system-speech-state",
            serde_json::json!({"id":id,"speaking":false,"error":result.err()}),
        );
    });
    Ok(())
}

#[cfg(windows)]
fn speak(text: String, stop: &AtomicBool) -> Result<(), String> {
    use windows::{
        Win32::{
            Media::Speech::{
                ISpVoice, SPRS_DONE, SPVOICESTATUS, SVSFIsNotXML, SVSFPurgeBeforeSpeak,
                SVSFlagsAsync, SpVoice,
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
) -> Result<(), String> {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    if stop.load(Ordering::SeqCst) {
        return Ok(());
    }
    let child = Command::new("/usr/bin/say")
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
fn speak(_: String, _: &AtomicBool) -> Result<(), String> {
    Err("当前平台暂未接入系统语音。".into())
}
