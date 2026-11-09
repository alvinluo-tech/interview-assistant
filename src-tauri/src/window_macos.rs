//! AppKit calls stay on Tauri's UI thread; raw handles never cross that thread.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Manager, Window};

/// Thread that owns the AppKit run loop, recorded from `setup`.
static UI_THREAD: OnceLock<std::thread::ThreadId> = OnceLock::new();

/// Tauri runs `setup` on the thread that pumps the native event loop.
pub fn record_ui_thread() {
    let _ = UI_THREAD.set(std::thread::current().id());
}

fn on_ui_thread() -> bool {
    UI_THREAD
        .get()
        .is_some_and(|id| *id == std::thread::current().id())
}

pub fn with_native<T: Send + 'static>(
    window: &Window,
    operation: impl FnOnce(*mut std::ffi::c_void) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    // Synchronous commands already run on the UI thread on macOS, so queueing
    // to that thread only blocks it until the timeout. Run inline there and
    // queue only from other threads (async commands, workers).
    if on_ui_thread() {
        // SAFETY: the UI thread owns the AppKit window.
        return window
            .ns_window()
            .map_err(|e| e.to_string())
            .and_then(operation);
    }
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    // A timed-out caller reports failure, so the queued work must not apply its
    // side effects afterwards; the flag turns that late run into a no-op.
    let cancelled = Arc::new(AtomicBool::new(false));
    let queued_cancel = cancelled.clone();
    let owned = window.clone();
    window
        .run_on_main_thread(move || {
            if queued_cancel.load(Ordering::SeqCst) {
                return;
            }
            let result = owned
                .ns_window()
                .map_err(|e| e.to_string())
                .and_then(operation);
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
    match rx.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(result) => result,
        Err(_) => {
            cancelled.store(true, Ordering::SeqCst);
            Err("Mac 窗口操作超时".to_string())
        }
    }
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
