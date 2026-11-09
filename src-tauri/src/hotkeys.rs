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

    // 出锁再派发：emit 会跑前端回调，回调可能重新设置快捷键，持锁会卡住全局热键线程。
    let action = {
        let map = routing
            .action_map
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        map.get(shortcut).cloned()
    };
    if let Some(action) = action {
        emit_action(app, &action, pressed);
        return;
    }
    let is_panic = {
        let panic_guard = routing
            .panic_shortcut
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
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

/// Applies a whole action-hotkey set atomically: new keys are registered before
/// any old key is released, so a conflict keeps the previous working set.
fn apply_action_hotkeys(
    previous: &HashMap<Shortcut, String>,
    desired: Vec<(Shortcut, String)>,
    mut register: impl FnMut(Shortcut) -> Result<(), String>,
    mut unregister: impl FnMut(Shortcut) -> Result<(), String>,
) -> Result<HashMap<Shortcut, String>, String> {
    let mut map = HashMap::new();
    let mut errors: Vec<String> = Vec::new();
    for (shortcut, action) in &desired {
        if let Some(other) = map.insert(*shortcut, action.clone()) {
            errors.push(format!("{action}: 与 {other} 使用了相同快捷键"));
        }
    }
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }
    let mut newly = Vec::new();
    for shortcut in map.keys() {
        if previous.contains_key(shortcut) {
            continue;
        }
        if let Err(error) = register(*shortcut) {
            for done in newly.iter().rev() {
                let _ = unregister(*done);
            }
            return Err(error);
        }
        newly.push(*shortcut);
    }
    for shortcut in previous.keys() {
        if !map.contains_key(shortcut) {
            if let Err(error) = unregister(*shortcut) {
                log::warn!("[hotkey] release {shortcut:?}: {error}");
            }
        }
    }
    Ok(map)
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
    // OS registration dispatches to the UI thread. Never hold locks read by
    // the shortcut handler while waiting for that dispatch to finish.
    let previous = state.action_map.lock().unwrap().clone();
    let mut desired: Vec<(Shortcut, String)> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    for b in bindings {
        match Shortcut::from_str(&b.accelerator) {
            Ok(sc) if Some(sc) == panic => errors.push(format!("{}: 与应急隐藏快捷键冲突", b.action)),
            Ok(sc) => desired.push((sc, b.action)),
            Err(e) => errors.push(format!("{}: {e}", b.action)),
        }
    }
    if !errors.is_empty() {
        log::warn!("[hotkey] rejected, keeping previous bindings: {errors:?}");
        return Err(errors.join("; "));
    }
    // Atomic replacement: the previous set stays registered until every new key
    // is accepted, so a single conflict no longer leaves the user without keys.
    let map = apply_action_hotkeys(
        &previous,
        desired,
        |shortcut| register_one(&app, shortcut),
        |shortcut| app.global_shortcut().unregister(shortcut).map_err(|e| e.to_string()),
    )?;
    let count = map.len();
    *state.action_map.lock().unwrap() = map;
    log::info!("[hotkey] action hotkeys active: {}", count);
    Ok(())
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
    let mut current = *state.panic_shortcut.lock().map_err(|_| "快捷键状态锁异常")?;
    let result = replace_panic_shortcut(&mut current, desired,
        |key| register_one(&app, key),
        |key| app.global_shortcut().unregister(key).map_err(|e| e.to_string()));
    let registered = current.is_some();
    *state.panic_shortcut.lock().map_err(|_| "快捷键状态锁异常")? = current;
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
    fn failed_action_rebind_keeps_previous_bindings() {
        let old = Shortcut::from_str("Control+Shift+A").unwrap();
        let new = Shortcut::from_str("Control+Shift+B").unwrap();
        let previous = HashMap::from([(old, "scroll".to_string())]);
        let unregistered = Cell::new(0);
        let failure = apply_action_hotkeys(
            &previous,
            vec![(new, "scroll".to_string())],
            |_| Err("occupied".into()),
            |_| { unregistered.set(unregistered.get() + 1); Ok(()) },
        );
        assert!(failure.is_err());
        assert_eq!(unregistered.get(), 0);
        let applied = apply_action_hotkeys(
            &previous,
            vec![(new, "scroll".to_string())],
            |_| Ok(()),
            |_| { unregistered.set(unregistered.get() + 1); Ok(()) },
        ).unwrap();
        assert_eq!(applied.get(&new).map(String::as_str), Some("scroll"));
        assert!(!applied.contains_key(&old));
        assert_eq!(unregistered.get(), 1);
    }

    #[test]
    fn duplicate_shortcuts_are_rejected() {
        let key = Shortcut::from_str("Control+Shift+A").unwrap();
        let applied = apply_action_hotkeys(
            &HashMap::new(),
            vec![(key, "scroll".to_string()), (key, "copy".to_string())],
            |_| Ok(()),
            |_| Ok(()),
        );
        assert!(applied.is_err());
    }
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
