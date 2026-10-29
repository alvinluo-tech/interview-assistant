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
    if state.overlay_visible.load(std::sync::atomic::Ordering::SeqCst) {
        // 瞬间隐藏浮窗（无提示）
        let _ = crate::overlay::cmd_hide_overlay(app.clone());
    } else if state.session_active.load(std::sync::atomic::Ordering::SeqCst) {
        let _ = crate::overlay::show_overlay_and_emit(app);
    } else {
        // 浮窗未显示：告知前端（提示 + 可按上一场快速重开）
        let _ = app.emit_to("main", "panic-hotkey-idle", ());
    }
}

fn register_one(
    app: &AppHandle,
    shortcut: Shortcut,
) -> Result<(), String> {
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
    // 先注销现有 action 快捷键
    {
        let mut map = state.action_map.lock().unwrap();
        for sc in map.keys() {
            let _ = app.global_shortcut().unregister(*sc);
        }
        map.clear();
    }
    let mut errors: Vec<String> = Vec::new();
    let mut map = state.action_map.lock().unwrap();
    for b in bindings {
        match Shortcut::from_str(&b.accelerator) {
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
    // 注销旧的
    if let Some(old) = state.panic_shortcut.lock().unwrap().take() {
        let _ = app.global_shortcut().unregister(old);
    }
    let registered = try_register_panic(&app, &state, accelerator.clone());
    let _ = app.emit_to("main", "panic-hotkey-status", PanicStatusPayload { registered });
    // 没注册上（被其它程序占用）→ 后台每 10s 重试，最多 30 次（原版同款自动重试）
    if !registered {
        if let Some(acc) = accelerator {
            let app2 = app.clone();
            std::thread::spawn(move || {
                for _ in 0..30 {
                    std::thread::sleep(std::time::Duration::from_secs(10));
                    let state: State<HotkeyRouting> = app2.state();
                    if state.panic_shortcut.lock().unwrap().is_some() {
                        return;
                    }
                    if try_register_panic(&app2, &state, Some(acc.clone())) {
                        let _ = app2.emit_to(
                            "main",
                            "panic-hotkey-status",
                            PanicStatusPayload { registered: true },
                        );
                        return;
                    }
                }
            });
        }
    }
    Ok(())
}

fn try_register_panic(
    app: &AppHandle,
    state: &State<'_, HotkeyRouting>,
    accelerator: Option<String>,
) -> bool {
    let Some(acc) = accelerator else { return false };
    match Shortcut::from_str(&acc) {
        Ok(sc) => match register_one(app, sc) {
            Ok(()) => {
                *state.panic_shortcut.lock().unwrap() = Some(sc);
                true
            }
            Err(e) => {
                log::warn!("[hotkey] panic hotkey register failed: {e}");
                false
            }
        },
        Err(e) => {
            log::warn!("[hotkey] panic hotkey parse failed: {e}");
            false
        }
    }
}

#[tauri::command]
pub fn cmd_panic_hotkey_status(state: State<'_, HotkeyRouting>) -> HashMap<String, bool> {
    let registered = state.panic_shortcut.lock().unwrap().is_some();
    HashMap::from([("registered".to_string(), registered)])
}
