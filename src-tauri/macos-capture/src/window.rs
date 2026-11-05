//! Small AppKit operations, called only through Tauri's main-thread dispatcher.
use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSScreenSaverWindowLevel, NSWindow, NSWindowCollectionBehavior as Behavior, NSWindowSharingType,
};
use std::ffi::c_void;

/// # Safety
/// `raw` must refer to the live NSWindow supplied by Tauri, on the main thread.
pub unsafe fn configure_overlay(raw: *mut c_void) -> Result<(), String> {
    let _main = MainThreadMarker::new().ok_or("Mac 窗口操作必须在主线程执行")?;
    // SAFETY: the caller keeps its Tauri Window alive throughout this call.
    let window = unsafe { raw.cast::<NSWindow>().as_ref() }.ok_or("Mac 窗口不存在")?;
    // The collection flags alone do not make an ordinary NSWindow eligible to
    // join another app's full-screen Space. Fail explicitly if the Tao panel
    // patch or its creation-time marker is missing.
    let is_panel: bool = unsafe { objc2::msg_send![window, isKindOfClass: objc2::class!(NSPanel)] };
    if !is_panel {
        return Err("Mac 浮窗必须以 NSPanel 创建，无法配置全屏空间跟随".into());
    }
    let behavior = window.collectionBehavior();
    let behavior = behavior.difference(
        Behavior::FullScreenPrimary
            | Behavior::FullScreenNone
            | Behavior::MoveToActiveSpace
            | Behavior::Primary
            | Behavior::Auxiliary,
    ) | Behavior::CanJoinAllSpaces
        | Behavior::CanJoinAllApplications
        | Behavior::FullScreenAuxiliary
        | Behavior::Stationary
        | Behavior::IgnoresCycle;
    window.setCollectionBehavior(behavior);
    // Ordinary floating windows can be obscured by another app's full-screen Space.
    window.setLevel(NSScreenSaverWindowLevel);
    window.setHidesOnDeactivate(false);
    Ok(())
}

/// Relinquish keyboard focus when the overlay returns to click-through mode.
///
/// # Safety
/// Same window lifetime and main-thread contract as `configure_overlay`.
pub unsafe fn resign_key_if_needed(raw: *mut c_void) -> Result<(), String> {
    let _main = MainThreadMarker::new().ok_or("Mac 窗口操作必须在主线程执行")?;
    let window = unsafe { raw.cast::<NSWindow>().as_ref() }.ok_or("Mac 窗口不存在")?;
    if window.isKeyWindow() {
        window.resignKeyWindow();
    }
    Ok(())
}

/// This reads only the legacy sharing property, not a capture guarantee.
/// # Safety
/// Same window lifetime and main-thread contract as `configure_overlay`.
pub unsafe fn sharing_restricted(raw: *mut c_void) -> Result<bool, String> {
    let _main = MainThreadMarker::new().ok_or("Mac 窗口操作必须在主线程执行")?;
    let window = unsafe { raw.cast::<NSWindow>().as_ref() }.ok_or("Mac 窗口不存在")?;
    Ok(window.sharingType() == NSWindowSharingType::None)
}
