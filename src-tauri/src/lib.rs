mod audio;
mod audio_dsp;
#[cfg(windows)]
mod audio_windows;
mod ai_settings;
mod data_store;
mod code_sandbox;
#[cfg(any(target_os = "macos", test))]
mod macos_secrets;
mod capture;
mod disguise;
mod dual_screen;
mod hotkeys;
#[cfg(windows)]
mod identity_resources;
mod misc;
mod overlay;
mod protection;
mod settings;

use hotkeys::HotkeyRouting;
use overlay::OverlayState;
use tauri::Manager;

/*
 * 复刻自原版的行为要点（见 _recon/spec）：
 * - overlay 窗口：透明/无边框/不进任务栏/不抢焦点，默认点击穿透；
 *   原生侧轮询光标命中「zones」并回发 cursor-zone 事件驱动悬停驻留交互。
 * - 捕获排除与进程身份切换见 protection / disguise；演示模式仅在本次运行生效。
 * - 单实例：二次启动唤回主窗口。
 * - guardian：release 下随主进程启动；仅异常退出时恢复，正常退出与重启不恢复。
 */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // guardian 模式：作为看门狗运行，不进入 Tauri 主流程
    let args: Vec<String> = std::env::args().collect();
    if args
        .iter()
        .any(|a| a == "--guardian" || a.starts_with("--guardian="))
    {
        #[cfg(windows)]
        {
            misc::guardian::run_guardian();
        }
        return;
    }

    let context = tauri::generate_context!();
    #[cfg(windows)]
    let startup_error = {
        if let Err(error) = disguise::wait_for_handoff() {
            eprintln!("[disguise] {error}");
            return;
        }
        match disguise::maybe_relaunch(&context.config().identifier) {
            Ok(true) => return,
            Ok(false) => None,
            Err(error) => {
                eprintln!("[disguise] {error}; running normally");
                Some(error)
            }
        }
    };
    #[cfg(not(windows))]
    let startup_error = None;
    let disguise_state = disguise::DisguiseState::default();
    *disguise_state.startup_error.lock().unwrap() = startup_error;

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 二次启动：唤回主窗口
            if let Some(main) = app.get_webview_window("main") {
                if let Some(window) = protection::window(app, "main") {
                    if let Err(error) =
                        protection::reapply(&window).and_then(|_| disguise::reapply(&window))
                    {
                        log::error!("[rewire] main: {error}");
                    }
                }
                let _ = main.unminimize();
                let _ = main.show();
                let _ = main.set_focus();
            }
            let _ = overlay::emit_overlay_shown_if_active(app);
        }))
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(hotkeys::global_shortcut_handler)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_websocket::init())
        .manage(ai_settings::AiSettingsLock::default())
        .manage(data_store::DataState::default())
        .manage(OverlayState::default())
        .manage(HotkeyRouting::default())
        .manage(audio::AudioCaptureState::default())
        .manage(protection::CaptureState::default())
        .manage(disguise_state)
        .manage(dual_screen::DualState::default())
        .on_page_load(|webview, _payload| {
            let window = webview.window();
            if let Err(error) =
                protection::reapply(&window).and_then(|_| disguise::reapply(&window))
            {
                log::error!("[rewire] {}: {error}", window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            ai_settings::cmd_ai_load_settings,
            ai_settings::cmd_ai_save_settings,
            data_store::cmd_data_read,
            data_store::cmd_data_commit,
            data_store::cmd_data_backup,
            code_sandbox::cmd_code_check,
            code_sandbox::cmd_code_run,
            // overlay 窗口控制
            overlay::cmd_show_overlay,
            overlay::cmd_hide_overlay,
            overlay::cmd_position_overlay,
            overlay::cmd_set_overlay_size,
            overlay::cmd_set_overlay_zones,
            overlay::cmd_set_overlay_interactive,
            overlay::cmd_set_drag_active,
            overlay::cmd_get_cursor_pos,
            overlay::cmd_set_cursor_point_feed,
            overlay::cmd_overlay_heartbeat,
            overlay::cmd_overlay_show_seq,
            overlay::cmd_overlay_session_ready,
            overlay::cmd_set_session_active,
            overlay::cmd_release_session_if_not_ready,
            overlay::cmd_apply_overlay_styles,
            overlay::cmd_overlay_debug,
            // 主窗口
            overlay::cmd_show_main,
            overlay::cmd_hide_main,
            overlay::cmd_minimize_main,
            // 热键
            hotkeys::cmd_set_action_hotkeys,
            hotkeys::cmd_set_panic_hotkey,
            hotkeys::cmd_panic_hotkey_status,
            // 系统音频
            audio::cmd_start_system_audio_capture,
            audio::cmd_stop_system_audio_capture,
            audio::cmd_list_system_audio_outputs,
            audio::cmd_set_system_audio_excluded_outputs,
            // 截屏与权限
            capture::cmd_capture_screen,
            capture::cmd_check_screen_capture_permission,
            capture::cmd_request_screen_capture_permission,
            capture::cmd_open_screen_recording_settings,
            protection::cmd_set_capture_excluded,
            protection::cmd_get_capture_status,
            protection::cmd_get_demo_visible_mode,
            protection::cmd_set_demo_visible_mode,
            disguise::cmd_get_disguise_status,
            disguise::cmd_set_disguise,
            disguise::cmd_relaunch,
            // 手机副屏（exam-dual 本地中继）
            dual_screen::cmd_dual_start,
            dual_screen::cmd_dual_send,
            dual_screen::cmd_dual_peer_count,
            dual_screen::cmd_dual_stop,
            overlay::cmd_get_overlay_rect,
            // 杂项
            misc::cmd_read_recent_logs,
            misc::cmd_read_native_crash,
            misc::cmd_clear_native_crash,
            misc::cmd_take_webview_crashes,
            misc::cmd_is_crash_recovery,
            misc::cmd_is_recovered_boot,
            misc::cmd_exit_app,
            misc::cmd_pending_newer_version,
            misc::cmd_os_version,
        ])
        .setup(|app| {
            if let Err(error) = protection::initialize(app.handle()) {
                log::error!("[capture] initialization: {error}");
            }
            if let Err(error) = disguise::initialize(app.handle()) {
                log::error!("[disguise] initialization: {error}");
                *app.state::<disguise::DisguiseState>()
                    .startup_error
                    .lock()
                    .unwrap() = Some(error);
            }
            if let Some(main) = app.get_webview_window("main") {
                main.show()?;
            }
            // 光标轮询线程：命中 zones → cursor-zone 事件（悬停驻留交互的核心）
            overlay::spawn_cursor_poller(app.handle().clone());
            // overlay 心跳看护线程：webview 假死检测
            overlay::spawn_heartbeat_watcher(app.handle().clone());
            // release 下拉起 guardian
            #[cfg(all(windows, not(debug_assertions)))]
            misc::guardian::spawn_guardian(app.handle().clone());
            Ok(())
        })
        .run(context)
        .expect("error while running tauri application");
}
