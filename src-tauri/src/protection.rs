//! Window display affinity is per HWND. Reapply on page load and before showing windows.
use serde::Serialize;
use std::{collections::BTreeMap, sync::Mutex};
use tauri::{AppHandle, Manager, Window};
use tauri_plugin_store::StoreExt;

pub const LABELS: [&str; 2] = ["main", "overlay"];
const EXCLUDED: u32 = 0x11;

#[derive(Clone)]
pub struct Policy {
    requested: BTreeMap<String, bool>,
    demo_visible: bool,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            requested: LABELS.into_iter().map(|s| (s.into(), true)).collect(),
            demo_visible: false,
        }
    }
}

impl Policy {
    fn affinity(&self, label: &str, bypass: bool) -> u32 {
        if self.requested.get(label).copied().unwrap_or(false) && !self.demo_visible && !bypass {
            EXCLUDED
        } else {
            0
        }
    }
}

#[derive(Default)]
pub struct CaptureState(pub Mutex<Policy>);

pub fn window(app: &AppHandle, label: &str) -> Option<Window> {
    app.get_webview_window(label).map(|w| w.as_ref().window())
}

pub fn dev_bypass() -> bool {
    std::env::var_os("MIANSHI_NO_WDA").is_some()
        || std::env::var_os("MIANLING_NO_WDA").is_some()
        || std::path::Path::new(r"C:\dev\skip-wda.flag").exists()
}

pub fn initialize(app: &AppHandle) -> Result<(), String> {
    let store = app.store("store.json").map_err(|e| e.to_string())?;
    let enabled = store
        .get("capture.excluded")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let state = app.state::<CaptureState>();
    let mut policy = state.0.lock().map_err(|e| e.to_string())?;
    for requested in policy.requested.values_mut() {
        *requested = enabled;
    }
    drop(policy);
    for label in LABELS {
        if let Some(window) = window(app, label) {
            if let Err(error) = reapply(&window) {
                log::error!("[capture] startup {label}: {error}");
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn read_affinity(window: &Window) -> Result<u32, String> {
    use windows::Win32::UI::WindowsAndMessaging::GetWindowDisplayAffinity;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    let mut affinity = 0;
    unsafe { GetWindowDisplayAffinity(hwnd, &mut affinity) }.map_err(|e| e.to_string())?;
    Ok(affinity)
}

#[cfg(windows)]
fn write_affinity(window: &Window, affinity: u32) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WINDOW_DISPLAY_AFFINITY,
    };
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    unsafe { SetWindowDisplayAffinity(hwnd, WINDOW_DISPLAY_AFFINITY(affinity)) }.map_err(|e| {
        format!(
            "{} SetWindowDisplayAffinity({affinity:#x}) 失败：{e}",
            window.label()
        )
    })?;
    let actual = read_affinity(window)?;
    if actual != affinity {
        return Err(format!("{} 捕获状态校验失败：{actual:#x}", window.label()));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn read_affinity(window: &Window) -> Result<u32, String> {
    crate::window_macos::with_native(window, |raw| {
        // SAFETY: live Tauri window, main-thread execution guaranteed by with_native.
        unsafe { mianxu_macos_capture::window::sharing_restricted(raw) }
            .map(|restricted| if restricted { EXCLUDED } else { 0 })
    })
}
#[cfg(target_os = "macos")]
fn write_affinity(window: &Window, value: u32) -> Result<(), String> {
    // Legacy AppKit sharing flag: best effort only. It cannot force third-party
    // ScreenCaptureKit streams to omit this window on current macOS versions.
    window
        .set_content_protected(value != 0)
        .map_err(|e| e.to_string())?;
    if read_affinity(window)? != value {
        return Err("Mac 窗口共享限制未应用".into());
    }
    Ok(())
}
#[cfg(not(any(windows, target_os = "macos")))]
fn read_affinity(_: &Window) -> Result<u32, String> {
    Err("捕获排除仅支持 Windows".into())
}
#[cfg(not(any(windows, target_os = "macos")))]
fn write_affinity(_: &Window, _: u32) -> Result<(), String> {
    Err("捕获排除仅支持 Windows".into())
}

pub fn reapply(window: &Window) -> Result<(), String> {
    if !cfg!(any(windows, target_os = "macos")) || !LABELS.contains(&window.label()) {
        return Ok(());
    }
    let Some(state) = window.app_handle().try_state::<CaptureState>() else {
        return Ok(());
    };
    let policy = state.0.lock().map_err(|e| e.to_string())?.clone();
    write_affinity(window, policy.affinity(window.label(), dev_bypass()))
}

/// Restore every touched HWND on a failed update, including the failing setter.
fn transaction(
    previous: &[u32],
    desired: &[u32],
    mut write: impl FnMut(usize, u32) -> Result<(), String>,
    persist: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let mut touched = 0;
    let result = (|| {
        for (index, affinity) in desired.iter().enumerate() {
            touched = index + 1;
            write(index, *affinity)?;
        }
        persist()
    })();
    if let Err(mut error) = result {
        for index in (0..touched).rev() {
            if let Err(rollback) = write(index, previous[index]) {
                error.push_str(&format!("；回滚失败：{rollback}"));
            }
        }
        return Err(error);
    }
    Ok(())
}

fn update(
    app: &AppHandle,
    label: Option<&str>,
    enable: Option<bool>,
    demo: Option<bool>,
) -> Result<(), String> {
    if !cfg!(any(windows, target_os = "macos")) {
        return Err("捕获排除仅支持 Windows".into());
    }
    if label.is_some_and(|label| !LABELS.contains(&label)) {
        return Err("仅支持 main / overlay 窗口".into());
    }
    let state = app.state::<CaptureState>();
    let mut policy = state.0.lock().map_err(|e| e.to_string())?;
    let mut next = policy.clone();
    if let Some(enable) = enable {
        for (key, requested) in &mut next.requested {
            if label.is_none_or(|label| key == label) {
                *requested = enable;
            }
        }
    }
    if let Some(demo) = demo {
        next.demo_visible = demo;
    }
    let windows: Vec<Window> = LABELS
        .into_iter()
        .filter_map(|label| window(app, label))
        .collect();
    let previous: Vec<_> = windows
        .iter()
        .map(read_affinity)
        .collect::<Result<_, _>>()?;
    let bypass = dev_bypass();
    let desired: Vec<_> = windows
        .iter()
        .map(|w| next.affinity(w.label(), bypass))
        .collect();
    transaction(
        &previous,
        &desired,
        |i, value| write_affinity(&windows[i], value),
        || {
            if let Some(enable) = enable.filter(|_| label.is_none()) {
                crate::settings::save(app, &[("capture.excluded", enable.into())])?;
            }
            Ok(())
        },
    )?;
    *policy = next;
    Ok(())
}

#[tauri::command]
pub fn cmd_set_capture_excluded(
    app: AppHandle,
    enable: bool,
    label: Option<String>,
) -> Result<(), String> {
    update(&app, label.as_deref(), Some(enable), None)
}

#[tauri::command]
pub fn cmd_get_demo_visible_mode(app: AppHandle) -> Result<bool, String> {
    Ok(app
        .state::<CaptureState>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .demo_visible)
}

#[tauri::command]
pub fn cmd_set_demo_visible_mode(app: AppHandle, enable: bool) -> Result<(), String> {
    update(&app, None, None, Some(enable))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowStatus {
    label: String,
    requested: bool,
    affinity: Option<u32>,
    sharing_restricted: Option<bool>,
    error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    supported: bool,
    protection_mode: &'static str,
    limitation: Option<&'static str>,
    demo_visible: bool,
    dev_bypass: bool,
    windows: Vec<WindowStatus>,
}

#[tauri::command]
pub fn cmd_get_capture_status(app: AppHandle) -> Result<CaptureStatus, String> {
    let state = app.state::<CaptureState>();
    // Never hold this lock while dispatching an AppKit read to the UI thread.
    let policy = state.0.lock().map_err(|e| e.to_string())?.clone();
    let windows = LABELS
        .into_iter()
        .map(|label| {
            let result = window(&app, label)
                .ok_or_else(|| "窗口未创建".to_string())
                .and_then(|w| read_affinity(&w));
            WindowStatus {
                label: label.into(),
                requested: policy.requested[label],
                affinity: if cfg!(windows) {
                    result.as_ref().ok().copied()
                } else {
                    None
                },
                sharing_restricted: if cfg!(target_os = "macos") {
                    result.as_ref().ok().map(|value| *value != 0)
                } else {
                    None
                },
                error: result.err(),
            }
        })
        .collect();
    Ok(CaptureStatus {
        supported: cfg!(any(windows, target_os = "macos")),
        protection_mode: if cfg!(windows) { "windowsAffinity" } else if cfg!(target_os = "macos") { "bestEffort" } else { "unsupported" },
        limitation: cfg!(target_os = "macos").then_some("macOS 的窗口共享限制只提供尽力保护，无法保证第三方录屏或会议共享不会捕获本应用；请用实际共享软件验证。"),
        demo_visible: policy.demo_visible,
        dev_bypass: dev_bypass(),
        windows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn demo_and_bypass_override_requested_policy_without_changing_it() {
        let mut policy = Policy::default();
        assert_eq!(policy.affinity("main", false), EXCLUDED);
        assert_eq!(policy.affinity("overlay", true), 0);
        policy.demo_visible = true;
        assert_eq!(policy.affinity("main", false), 0);
        policy.demo_visible = false;
        assert_eq!(policy.affinity("main", false), EXCLUDED);
        policy.requested.insert("overlay".into(), false);
        assert_eq!(policy.affinity("overlay", false), 0);
    }
    #[test]
    fn failed_second_window_restores_both_windows() {
        let mut values = [EXCLUDED, EXCLUDED];
        let mut fail = true;
        let result = transaction(
            &values.clone(),
            &[0, 0],
            |i, value| {
                values[i] = value;
                if i == 1 && fail {
                    fail = false;
                    Err("failure".into())
                } else {
                    Ok(())
                }
            },
            || panic!("failed changes must not persist"),
        );
        assert!(result.is_err());
        assert_eq!(values, [EXCLUDED, EXCLUDED]);
    }
    #[test]
    fn persistence_failure_restores_native_state() {
        let mut values = [0, 0];
        assert!(
            transaction(
                &[0, 0],
                &[EXCLUDED, EXCLUDED],
                |i, v| {
                    values[i] = v;
                    Ok(())
                },
                || Err("disk full".into())
            )
            .is_err()
        );
        assert_eq!(values, [0, 0]);
    }
}
