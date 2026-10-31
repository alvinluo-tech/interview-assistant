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

/// This reads only the legacy sharing property, not a capture guarantee.
/// # Safety
/// Same window lifetime and main-thread contract as `configure_overlay`.
pub unsafe fn sharing_restricted(raw: *mut c_void) -> Result<bool, String> {
    let _main = MainThreadMarker::new().ok_or("Mac 窗口操作必须在主线程执行")?;
    let window = unsafe { raw.cast::<NSWindow>().as_ref() }.ok_or("Mac 窗口不存在")?;
    Ok(window.sharingType() == NSWindowSharingType::None)
}
