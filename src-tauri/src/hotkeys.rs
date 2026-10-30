/*
 * 全局热键：18 个浮窗动作热键 + 应急隐藏（panic）热键。
 * 对齐原版：按下沿/松开沿都上报（scroll/move 需要按住型），panic 在浮窗
 * 显示时切换隐藏/恢复，浮窗未显示时上报 panic-hotkey-idle。
 */
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

#[derive(Clone, Serialize)]
pub struct ActionHotkeyPayload {
    pub action: String,
    pub pressed: bool,
}

#[derive(Clone, Serialize)]
pub struct PanicStatusPayload {
    pub registered: bool,
}

#[derive(Default)]
pub struct HotkeyRouting {
    registration_lock: Mutex<()>,
    /// 当前已注册的 action 快捷键 → action 名
    pub action_map: Mutex<HashMap<Shortcut, String>>,
    pub panic_shortcut: Mutex<Option<Shortcut>>,
}

#[derive(Deserialize)]
pub struct HotkeyBinding {
    pub action: String,
    pub accelerator: String,
}

fn emit_action(app: &AppHandle, action: &str, pressed: bool) {
    let _ = app.emit_to(
        "overlay",
        "action-hotkeys",
        ActionHotkeyPayload {
            action: action.to_string(),
            pressed,
        },
    );
}

pub fn global_shortcut_handler(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    let routing: State<HotkeyRouting> = app.state();
    let pressed = event.state() == ShortcutState::Pressed;

    if let Some(action) = routing.action_map.lock().unwrap().get(shortcut) {
        let action = action.clone();
        emit_action(app, &action, pressed);
        return;
    }
    let is_panic = {
        let panic_guard = routing.panic_shortcut.lock().unwrap();
        panic_guard.as_ref() == Some(shortcut)
    };
    if is_panic && pressed {
        handle_panic(app);
    }
}

fn handle_panic(app: &AppHandle) {
    let state = app.state::<crate::overlay::OverlayState>();
    if state
        .overlay_visible
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        // 瞬间隐藏浮窗（无提示）
        let _ = crate::overlay::cmd_hide_overlay(app.clone());
    } else if state
        .session_active
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        let _ = crate::overlay::show_overlay_and_emit(app);
    } else {
        // 浮窗未显示：告知前端（提示 + 可按上一场快速重开）
        let _ = app.emit_to("main", "panic-hotkey-idle", ());
    }
}

fn register_one(app: &AppHandle, shortcut: Shortcut) -> Result<(), String> {
    if app.global_shortcut().is_registered(shortcut) {
        return Ok(());
    }
    app.global_shortcut()
        .register(shortcut)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cmd_set_action_hotkeys(
    app: AppHandle,
    state: State<'_, HotkeyRouting>,
    bindings: Vec<HotkeyBinding>,
) -> Result<(), String> {
    let _registration = state.registration_lock.lock().map_err(|_| "快捷键注册锁异常")?;
    let panic = *state.panic_shortcut.lock().map_err(|_| "快捷键状态锁异常")?;
    // 先注销现有 action 快捷键
    {
        let mut map = state.action_map.lock().unwrap();
        for sc in map.keys() {
            if Some(*sc) != panic { let _ = app.global_shortcut().unregister(*sc); }
        }
        map.clear();
    }
    let mut errors: Vec<String> = Vec::new();
    let mut map = state.action_map.lock().unwrap();
    for b in bindings {
        match Shortcut::from_str(&b.accelerator) {
            Ok(sc) if Some(sc) == panic => errors.push(format!("{}: 与应急隐藏快捷键冲突", b.action)),
            Ok(sc) => match register_one(&app, sc) {
                Ok(()) => {
                    map.insert(sc, b.action.clone());
                }
                Err(e) => errors.push(format!("{}: {e}", b.action)),
            },
            Err(e) => errors.push(format!("{}: {e}", b.action)),
        }
    }
    if errors.is_empty() {
        log::info!("[hotkey] action hotkeys active: {} ok, 0 failed", map.len());
        Ok(())
    } else {
        log::warn!("[hotkey] action hotkeys partially failed: {errors:?}");
        Err(errors.join("; "))
    }
}

#[tauri::command]
pub fn cmd_set_panic_hotkey(
    app: AppHandle,
    state: State<'_, HotkeyRouting>,
    accelerator: Option<String>,
) -> Result<(), String> {
    let _registration = state.registration_lock.lock().map_err(|_| "快捷键注册锁异常")?;
    let desired = accelerator.as_deref().map(Shortcut::from_str).transpose()
        .map_err(|e| format!("快捷键无效：{e}"))?;
    if desired.is_some_and(|key| state.action_map.lock().unwrap().contains_key(&key)) {
        return Err("此快捷键已被浮窗动作占用，请选择其他组合。".into());
    }
    let mut current = state.panic_shortcut.lock().map_err(|_| "快捷键状态锁异常")?;
    let result = replace_panic_shortcut(&mut current, desired,
        |key| register_one(&app, key),
        |key| app.global_shortcut().unregister(key).map_err(|e| e.to_string()));
    let registered = current.is_some();
    drop(current);
    let _ = app.emit_to("main", "panic-hotkey-status", PanicStatusPayload { registered });
    // Conflicts require user action. No detached retries survive a setting change.
    result.map_err(|e| format!("应急隐藏快捷键未生效，可能已被其他程序占用，请更换组合：{e}"))
}

fn replace_panic_shortcut(
    current: &mut Option<Shortcut>, desired: Option<Shortcut>,
    mut register: impl FnMut(Shortcut) -> Result<(), String>,
    mut unregister: impl FnMut(Shortcut) -> Result<(), String>,
) -> Result<(), String> {
    if *current == desired { return Ok(()); }
    if let Some(new) = desired { register(new)?; }
    if let Some(old) = *current {
        if let Err(error) = unregister(old) {
            if let Some(new) = desired { let _ = unregister(new); }
            return Err(error);
        }
    }
    *current = desired;
    Ok(())
}

#[tauri::command]
pub fn cmd_panic_hotkey_status(state: State<'_, HotkeyRouting>) -> HashMap<String, bool> {
    let registered = state.panic_shortcut.lock().unwrap().is_some();
    HashMap::from([("registered".to_string(), registered)])
}

#[cfg(test)]
mod audit_tests {
    use super::*;
    use std::cell::Cell;
    #[test]
    fn panic_replacement_is_idempotent_and_keeps_working_key_on_conflict() {
        let old = Shortcut::from_str("Control+Shift+X").unwrap();
        let new = Shortcut::from_str("Control+Shift+Y").unwrap();
        let mut current = Some(old);
        let registrations = Cell::new(0);
        let unregistrations = Cell::new(0);
        replace_panic_shortcut(&mut current, Some(old), |_| { registrations.set(registrations.get()+1); Ok(()) }, |_| {unregistrations.set(unregistrations.get()+1); Ok(())}).unwrap();
        assert_eq!(registrations.get(), 0);
        assert_eq!(unregistrations.get(), 0);
        assert!(replace_panic_shortcut(&mut current, Some(new), |_| Err("occupied".into()), |_| {unregistrations.set(unregistrations.get()+1); Ok(())}).is_err());
        assert_eq!(current, Some(old));
        assert_eq!(unregistrations.get(), 0);
        replace_panic_shortcut(&mut current, None, |_| Ok(()), |_| Ok(())).unwrap();
        assert!(current.is_none());
    }
    #[test]
    fn recorder_key_names_parse_in_the_actual_native_shortcut_library() {
        for key in ["Escape","NumpadAdd","NumpadSubtract","NumpadMultiply","NumpadDivide","NumpadDecimal","NumpadEnter"] {
            assert!(Shortcut::from_str(key).is_ok(), "{key}");
        }
    }
}
