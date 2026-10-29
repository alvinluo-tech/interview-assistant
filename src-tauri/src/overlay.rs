/*
 * overlay 窗口控制：显示/隐藏/位置/尺寸、点击穿透与 zones 光标命中、
 * 心跳看护、会话握手。逻辑对齐原版 overlay_watchdog / window_ops。
 */
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, State, WebviewWindow};

#[derive(Serialize, Clone)]
pub struct SeqPayload {
    pub seq: i64,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct ZoneRect {
    pub id: String,
    /// 物理屏幕坐标（前端用 dpr 换算后上报）
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone, Serialize)]
pub struct CursorZonePayload {
    #[serde(rename = "zoneId")]
    pub zone_id: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct CursorPointPayload {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Serialize)]
pub struct DragModePayload {
    pub active: bool,
}

#[derive(Clone, Serialize)]
pub struct SessionReadyPayload {
    pub seq: i64,
    pub business: bool,
}

pub struct OverlayState {
    pub zones: Mutex<Vec<ZoneRect>>,
    pub interactive: AtomicBool,
    pub drag_active: AtomicBool,
    pub cursor_feed: AtomicBool,
    pub overlay_visible: AtomicBool,
    pub session_active: AtomicBool,
    pub last_hit: Mutex<Option<String>>,
    pub show_seq: AtomicI64,
    /// overlay webview 最近一次心跳 / 会话握手 seq
    pub last_heartbeat: Mutex<Instant>,
    pub ready_seq: AtomicI64,
    /// 光标轮询线程计数（诊断用）
    pub poll_ticks: std::sync::atomic::AtomicU64,
    /// 上次 cursor-point 上报位置（只在移动时上报）
    pub last_cursor_point: Mutex<Option<(i32, i32)>>,
}

impl Default for OverlayState {
    fn default() -> Self {
        Self {
            zones: Mutex::new(Vec::new()),
            interactive: AtomicBool::new(false),
            drag_active: AtomicBool::new(false),
            cursor_feed: AtomicBool::new(false),
            overlay_visible: AtomicBool::new(false),
            session_active: AtomicBool::new(false),
            last_hit: Mutex::new(None),
            show_seq: AtomicI64::new(0),
            last_heartbeat: Mutex::new(Instant::now()),
            ready_seq: AtomicI64::new(0),
            poll_ticks: std::sync::atomic::AtomicU64::new(0),
            last_cursor_point: Mutex::new(None),
        }
    }
}

fn overlay_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("overlay")
}

/// 显示浮窗：seq 自增、广播 overlay-shown、按 interactive 设置穿透。返回 seq。
pub fn show_overlay_and_emit(app: &AppHandle) -> Result<i64, String> {
    let state: State<OverlayState> = app.state();
    let win = overlay_window(app).ok_or("overlay window missing")?;
    let native =
        crate::protection::window(app, "overlay").ok_or("overlay native window missing")?;
    crate::protection::reapply(&native)?;
    crate::disguise::reapply(&native)?;
    #[cfg(target_os = "macos")]
    crate::window_macos::configure_overlay(&native)?;
    let seq = state.show_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let interactive = state.interactive.load(Ordering::SeqCst);
    let _ = win.set_ignore_cursor_events(!interactive);
    let _ = win.set_focusable(interactive);
    win.show().map_err(|e| e.to_string())?;
    state.overlay_visible.store(true, Ordering::SeqCst);
    *state.last_heartbeat.lock().unwrap() = Instant::now();
    let _ = app.emit_to("overlay", "overlay-shown", SeqPayload { seq });
    let _ = app.emit_to("main", "overlay-shown", SeqPayload { seq });
    log::info!("[show_overlay] done, seq={seq}");
    Ok(seq)
}

/// 单实例回调里使用：若会话仍然活跃则把浮窗带回来
pub fn emit_overlay_shown_if_active(app: &AppHandle) -> Result<(), String> {
    let state: State<OverlayState> = app.state();
    if state.session_active.load(Ordering::SeqCst) {
        show_overlay_and_emit(app)?;
    }
    Ok(())
}

#[tauri::command]
pub fn cmd_show_overlay(app: AppHandle) -> Result<i64, String> {
    show_overlay_and_emit(&app)
}

#[tauri::command]
pub fn cmd_hide_overlay(app: AppHandle) -> Result<(), String> {
    let state: State<OverlayState> = app.state();
    state.overlay_visible.store(false, Ordering::SeqCst);
    *state.last_hit.lock().unwrap() = None;
    let _ = app.emit_to("overlay", "overlay-hidden", ());
    let _ = app.emit_to("main", "overlay-hidden", ());
    if let Some(win) = overlay_window(&app) {
        win.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn cmd_position_overlay(app: AppHandle, pos: PhysicalPosition<i32>) -> Result<(), String> {
    let win = overlay_window(&app).ok_or("overlay window missing")?;
    win.set_position(pos).map_err(|e| e.to_string())
}

/// 前端传逻辑像素（与 overlay.style 里 examWidth/interviewWidth 同一坐标系）
#[tauri::command]
pub fn cmd_set_overlay_size(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let win = overlay_window(&app).ok_or("overlay window missing")?;
    win.set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cmd_set_overlay_zones(state: State<'_, OverlayState>, zones: Vec<ZoneRect>) {
    *state.zones.lock().unwrap() = zones;
}

#[tauri::command]
pub fn cmd_set_overlay_interactive(
    app: AppHandle,
    state: State<'_, OverlayState>,
    interactive: bool,
) -> Result<(), String> {
    state.interactive.store(interactive, Ordering::SeqCst);
    if let Some(win) = overlay_window(&app) {
        let _ = win.set_ignore_cursor_events(!interactive);
        let _ = win.set_focusable(interactive);
    }
    Ok(())
}

#[tauri::command]
pub fn cmd_set_drag_active(
    app: AppHandle,
    state: State<'_, OverlayState>,
    active: bool,
) -> Result<(), String> {
    if state.drag_active.swap(active, Ordering::SeqCst) && active { return Ok(()); }
    let _ = app.emit_to("overlay", "drag-mode-changed", DragModePayload { active });
    if !active {
        return Ok(());
    }
    // 悬停进入拖动：窗口跟随光标，光标静止 0.8s 即释放（原版语义）
    let win = overlay_window(&app).ok_or("overlay window missing")?;
    #[cfg(any(windows, target_os = "macos"))]
    {
        std::thread::spawn(move || {
            if let Err(error) = follow_cursor(&win) { log::warn!("[overlay-drag] {error}"); }
            let st: State<OverlayState> = win.app_handle().state();
            st.drag_active.store(false, Ordering::SeqCst);
            let _ = win.app_handle().emit_to(
                "overlay",
                "drag-mode-changed",
                DragModePayload { active: false },
            );
        });
    }
    Ok(())
}

fn drag_cursor(app: &AppHandle) -> Result<(f64, f64), String> {
    let p = app.cursor_position().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        let scale = app.primary_monitor().map_err(|e| e.to_string())?.ok_or("主显示器不可用")?.scale_factor();
        return Ok((p.x / scale, p.y / scale));
    }
    #[cfg(not(target_os = "macos"))]
    Ok((p.x, p.y))
}

fn follow_cursor(win: &WebviewWindow) -> Result<(), String> {
    let start = win.outer_position().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    let scale = win.scale_factor().map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "macos"))]
    let scale = 1.0;
    let origin = (start.x as f64 / scale, start.y as f64 / scale);
    let cursor = drag_cursor(win.app_handle())?;
    let mut last = cursor;
    let mut last_move = Instant::now();
    loop {
        std::thread::sleep(Duration::from_millis(16));
        let state: State<OverlayState> = win.app_handle().state();
        if !state.drag_active.load(Ordering::SeqCst) || !state.overlay_visible.load(Ordering::SeqCst) { break; }
        let current = drag_cursor(win.app_handle())?;
        if current != last {
            last = current;
            last_move = Instant::now();
            let x = origin.0 + current.0 - cursor.0;
            let y = origin.1 + current.1 - cursor.1;
            #[cfg(target_os = "macos")]
            win.set_position(tauri::LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
            #[cfg(not(target_os = "macos"))]
            win.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32)).map_err(|e| e.to_string())?;
        } else if last_move.elapsed() > Duration::from_millis(800) { break; }
    }
    Ok(())
}

#[tauri::command]
pub fn cmd_get_cursor_pos(app: AppHandle) -> Result<(i32, i32), String> {
    #[cfg(not(target_os = "macos"))]
    let _ = &app;
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut p = POINT::default();
        unsafe { GetCursorPos(&mut p) }.map_err(|e| e.to_string())?;
        Ok((p.x, p.y))
    }
    #[cfg(target_os = "macos")]
    {
        let primary = app.primary_monitor().map_err(|e| e.to_string())?.ok_or("主显示器不可用")?.scale_factor();
        let scale = overlay_window(&app).ok_or("浮窗不存在")?.scale_factor().map_err(|e| e.to_string())?;
        let cursor = app.cursor_position().map_err(|e| e.to_string())?;
        mianxu_macos_capture::selection::cursor_in_window_space((cursor.x, cursor.y), primary, scale)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Err("unsupported platform".into())
    }
}

/// 副屏光标归一化用：浮窗窗口屏幕矩形 (x, y, w, h)
#[tauri::command]
pub fn cmd_get_overlay_rect(app: AppHandle) -> Result<(i32, i32, u32, u32), String> {
    let win = app
        .get_webview_window("overlay")
        .ok_or("overlay window not found")?;
    let pos = win.outer_position().map_err(|e| e.to_string())?;
    let size = win.outer_size().map_err(|e| e.to_string())?;
    Ok((pos.x, pos.y, size.width, size.height))
}

#[tauri::command]
pub fn cmd_set_cursor_point_feed(state: State<'_, OverlayState>, on: bool) {
    state.cursor_feed.store(on, Ordering::SeqCst);
}

#[tauri::command]
pub fn cmd_overlay_heartbeat(state: State<'_, OverlayState>) {
    *state.last_heartbeat.lock().unwrap() = Instant::now();
}

#[tauri::command]
pub fn cmd_overlay_show_seq(state: State<'_, OverlayState>) -> i64 {
    if state.overlay_visible.load(Ordering::SeqCst) {
        state.show_seq.load(Ordering::SeqCst)
    } else {
        0
    }
}

#[tauri::command]
pub fn cmd_overlay_session_ready(
    app: AppHandle,
    state: State<'_, OverlayState>,
    seq: i64,
    business: bool,
) {
    *state.last_heartbeat.lock().unwrap() = Instant::now();
    state.ready_seq.store(seq, Ordering::SeqCst);
    let _ = app.emit_to(
        "main",
        "overlay-session-ready",
        SessionReadyPayload { seq, business },
    );
}

#[tauri::command]
pub fn cmd_set_session_active(state: State<'_, OverlayState>, active: bool) {
    state.session_active.store(active, Ordering::SeqCst);
    if active {
        *state.last_heartbeat.lock().unwrap() = Instant::now();
    }
}

/// 崩溃恢复握手：返回 true 表示该 seq 尚未就绪（前端据此判定恢复失败）
#[tauri::command]
pub fn cmd_release_session_if_not_ready(state: State<'_, OverlayState>, seq: i64) -> bool {
    state.ready_seq.load(Ordering::SeqCst) != seq
}

/// 样式由配置承担；每次刷新时重新挂载当前捕获策略和窗口身份。
#[tauri::command]
pub fn cmd_apply_overlay_styles(
    app: AppHandle,
    styles: Option<serde_json::Value>,
) -> Result<(), String> {
    let _ = styles;
    if let Some(window) = crate::protection::window(&app, "overlay") {
        #[cfg(target_os = "macos")]
        crate::window_macos::configure_overlay(&window)?;
        crate::protection::reapply(&window)?;
        crate::disguise::reapply(&window)?;
    }
    Ok(())
}

/// 诊断：返回 overlay 原生状态（zones 数量、穿透状态、命中 zone 等）
#[tauri::command]
pub fn cmd_overlay_debug(state: State<'_, OverlayState>) -> serde_json::Value {
    serde_json::json!({
        "zones": state.zones.lock().unwrap().len(),
        "interactive": state.interactive.load(Ordering::SeqCst),
        "visible": state.overlay_visible.load(Ordering::SeqCst),
        "dragActive": state.drag_active.load(Ordering::SeqCst),
        "lastHit": state.last_hit.lock().unwrap().clone(),
        "showSeq": state.show_seq.load(Ordering::SeqCst),
        "readySeq": state.ready_seq.load(Ordering::SeqCst),
        "zoneIds": state.zones.lock().unwrap().iter().map(|z| z.id.clone()).collect::<Vec<_>>(),
    })
}

// ---------- 主窗口 ----------

#[tauri::command]
pub fn cmd_show_main(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        if let Some(window) = crate::protection::window(&app, "main") {
            crate::protection::reapply(&window)?;
            crate::disguise::reapply(&window)?;
        }
        let _ = win.unminimize();
        win.show().map_err(|e| e.to_string())?;
        let _ = win.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub fn cmd_hide_main(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn cmd_minimize_main(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.minimize().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------- 后台线程 ----------

pub fn spawn_cursor_poller(app: AppHandle) {
    std::thread::spawn(move || {
        #[cfg(any(windows, target_os = "macos"))]
        loop {
            std::thread::sleep(Duration::from_millis(16));
            let state: State<OverlayState> = app.state();
            if !state.overlay_visible.load(Ordering::SeqCst)
                || state.drag_active.load(Ordering::SeqCst)
            {
                continue;
            }
            state
                .poll_ticks
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let interactive = state.interactive.load(Ordering::SeqCst);
            let feed = state.cursor_feed.load(Ordering::SeqCst);
            let Ok((x, y)) = cmd_get_cursor_pos(app.clone()) else { continue; };
            let p = PhysicalPosition::new(x, y);
            if feed {
                // 仅在移动时上报（原版同样只在变化时喂光标），避免高频事件淹没 WebView2 通道
                let mut last = state.last_cursor_point.lock().unwrap();
                if last.map(|(x, y)| x != p.x || y != p.y).unwrap_or(true) {
                    *last = Some((p.x, p.y));
                    drop(last);
                    let _ = app.emit_to(
                        "overlay",
                        "cursor-point",
                        CursorPointPayload { x: p.x, y: p.y },
                    );
                }
            }
            if interactive {
                let mut last = state.last_hit.lock().unwrap();
                if last.take().is_some() {
                    let _ = app.emit_to(
                        "overlay",
                        "cursor-zone",
                        CursorZonePayload { zone_id: None },
                    );
                }
                continue;
            }
            // 命中检测
            let zones = state.zones.lock().unwrap();
            let hit = zones
                .iter()
                .find(|z| p.x >= z.x && p.x < z.x + z.width && p.y >= z.y && p.y < z.y + z.height);
            let hit_id = hit.map(|z| z.id.clone());
            drop(zones);
            let mut last = state.last_hit.lock().unwrap();
            if *last != hit_id {
                *last = hit_id.clone();
                let _ = app.emit_to(
                    "overlay",
                    "cursor-zone",
                    CursorZonePayload { zone_id: hit_id },
                );
            }
        }
    });
}

pub fn spawn_heartbeat_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(5));
            let state: State<OverlayState> = app.state();
            if !state.overlay_visible.load(Ordering::SeqCst)
                || !state.session_active.load(Ordering::SeqCst)
            {
                continue;
            }
            let elapsed = state.last_heartbeat.lock().unwrap().elapsed();
            if elapsed > Duration::from_secs(20) {
                log::warn!("[overlay-watchdog] overlay webview heartbeat lost ({elapsed:?})");
                state.overlay_visible.store(false, Ordering::SeqCst);
                if let Some(win) = overlay_window(&app) {
                    let _ = win.hide();
                }
                let _ = app.emit_to("main", "overlay-webview-dead", ());
            }
        }
    });
}
