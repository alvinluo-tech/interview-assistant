//! AppKit calls stay on Tauri's UI thread; raw handles never cross that thread.
use tauri::Window;

pub fn with_native<T: Send + 'static>(window: &Window, operation: impl FnOnce(*mut std::ffi::c_void) -> Result<T, String> + Send + 'static) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let owned = window.clone();
    window.run_on_main_thread(move || {
        let result = owned.ns_window().map_err(|e| e.to_string()).and_then(operation);
        let _ = tx.send(result);
    }).map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(3)).map_err(|_| "Mac 窗口操作超时".to_string())?
}

pub fn configure_overlay(window: &Window) -> Result<(), String> {
    window.set_always_on_top(true).map_err(|e| e.to_string())?;
    with_native(window, |raw| {
        // SAFETY: with_native holds the live Tauri window on the main thread.
        unsafe { mianxu_macos_capture::window::configure_overlay(raw) }
    })
}
