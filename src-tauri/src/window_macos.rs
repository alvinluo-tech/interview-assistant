//! AppKit calls stay on Tauri's UI thread; raw handles never cross that thread.
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, Window};

pub fn with_native<T: Send + 'static>(
    window: &Window,
    operation: impl FnOnce(*mut std::ffi::c_void) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let owned = window.clone();
    window
        .run_on_main_thread(move || {
            let result = owned
                .ns_window()
                .map_err(|e| e.to_string())
                .and_then(operation);
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(3))
        .map_err(|_| "Mac 窗口操作超时".to_string())?
}

pub fn configure_overlay(window: &Window) -> Result<(), String> {
    // Tao schedules set_always_on_top asynchronously on the main queue and can
    // overwrite the native level below with NSFloatingWindowLevel afterwards.
    with_native(window, |raw| {
        // SAFETY: with_native holds the live Tauri window on the main thread.
        unsafe { mianxu_macos_capture::window::configure_overlay(raw) }
    })
}

pub fn release_overlay_focus_if_noninteractive(app: &AppHandle) -> Result<(), String> {
    let Some(window) = crate::protection::window(app, "overlay") else {
        return Ok(());
    };
    let app = app.clone();
    with_native(&window, move |raw| {
        // A later interaction toggle may have superseded the request while it
        // was queued on the main thread.
        if app.state::<crate::overlay::OverlayState>().interactive.load(Ordering::SeqCst) {
            return Ok(());
        }
        // SAFETY: with_native holds the live Tauri window on the main thread.
        unsafe { mianxu_macos_capture::window::resign_key_if_needed(raw) }
    })
}
