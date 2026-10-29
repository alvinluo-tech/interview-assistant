/*
 * 杂项命令：日志读取、崩溃存根、退出、版本查询。重启见 disguise。
 * 崩溃/恢复类命令返回"非恢复启动"（冷启动），与原版语义兼容。
 */
use std::io::{BufRead, Seek, SeekFrom};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn cmd_read_recent_logs(app: AppHandle, limit: Option<usize>) -> Result<Vec<String>, String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    // tauri-plugin-log 默认文件名 = productName
    let path = dir.join("骆耀升老公酱面试助手.log");
    let f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut reader = std::io::BufReader::new(f);
    let mut lines: Vec<String> = Vec::new();
    reader.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    for line in reader.lines() {
        match line {
            Ok(l) => lines.push(l),
            Err(_) => break,
        }
    }
    let limit = limit.unwrap_or(200);
    let start = lines.len().saturating_sub(limit);
    Ok(lines[start..].to_vec())
}

// ---------- 崩溃存根（本复刻不做崩溃恢复引导） ----------

#[tauri::command]
pub fn cmd_read_native_crash() -> Option<String> {
    None
}

#[tauri::command]
pub fn cmd_clear_native_crash() {}

#[tauri::command]
pub fn cmd_take_webview_crashes() -> Vec<String> {
    Vec::new()
}

#[tauri::command]
pub fn cmd_is_crash_recovery() -> bool {
    false
}

#[tauri::command]
pub fn cmd_is_recovered_boot() -> bool {
    false
}

#[tauri::command]
pub fn cmd_exit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn cmd_pending_newer_version() -> Option<String> {
    None
}

#[tauri::command]
pub fn cmd_os_version() -> String {
    #[cfg(windows)]
    {
        // 读取注册表当前版本号（DisplayVersion/CurrentBuild）
        use windows::Win32::System::Registry::{HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RegGetValueW};
        let sub: Vec<u16> = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\0"
            .encode_utf16()
            .collect();
        for value in ["DisplayVersion\0", "CurrentBuildNumber\0"] {
            let val: Vec<u16> = value.encode_utf16().collect();
            let mut buf = [0u16; 64];
            let mut size = (buf.len() * 2) as u32;
            let rc = unsafe {
                RegGetValueW(
                    HKEY_LOCAL_MACHINE,
                    windows::core::PCWSTR(sub.as_ptr()),
                    windows::core::PCWSTR(val.as_ptr()),
                    RRF_RT_REG_SZ,
                    None,
                    Some(buf.as_mut_ptr() as _),
                    Some(&mut size),
                )
            };
            if rc.is_ok() {
                let len = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
                return String::from_utf16_lossy(&buf[..len]);
            }
        }
        "windows".to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::consts::OS.to_string()
    }
}

// ---------------- guardian（守护进程） ----------------

#[cfg(windows)]
pub mod guardian {
    static CHILD: std::sync::Mutex<Option<std::process::Child>> = std::sync::Mutex::new(None);
    static UPDATING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

    pub(crate) fn stop_for_update() {
        UPDATING.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Ok(mut slot) = CHILD.lock() {
            if let Some(mut child) = slot.take() { let _ = child.kill(); let _ = child.wait(); }
        }
    }
    /// 主进程：拉起守护进程（release only）
    #[cfg(not(debug_assertions))]
    pub fn spawn_guardian(_app: tauri::AppHandle) {
        let exe = match std::env::current_exe() {
            Ok(e) => e,
            Err(_) => return,
        };
        let pid = std::process::id();
        std::thread::spawn(move || {
            use std::os::windows::process::CommandExt;
            const DETACHED_PROCESS: u32 = 0x0000_0008;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0800_0000;
            // 先尝试脱离作业对象（从 IDE/终端启动时常见），失败则退回普通分离进程
            let spawned = std::process::Command::new(&exe)
                .arg(format!("--guardian={pid}"))
                .env_remove(crate::disguise::PARENT)
                .creation_flags(
                    DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB,
                )
                .spawn();
            let spawned = spawned.or_else(|_| std::process::Command::new(&exe)
                    .arg(format!("--guardian={pid}"))
                    .env_remove(crate::disguise::PARENT)
                    .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
                    .spawn());
            if let Ok(mut child) = spawned {
                let mut slot = CHILD.lock().unwrap();
                if UPDATING.load(std::sync::atomic::Ordering::SeqCst) { let _ = child.kill(); let _ = child.wait(); }
                else { *slot = Some(child); }
            }
        });
    }

    /// 守护进程主循环：等主进程异常退出后拉起新实例
    pub fn run_guardian() {
        let pid: u32 = std::env::args()
            .find_map(|a| a.strip_prefix("--guardian=").map(|v| v.to_string()))
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        if pid == 0 {
            return;
        }
        use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
        use windows::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_SYNCHRONIZE, WaitForSingleObject,
        };
        unsafe {
            if let Ok(handle) = OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                false,
                pid,
            ) {
                // 最多盯 7 天，避免孤儿守护
                let wait = WaitForSingleObject(handle, 7 * 24 * 3600 * 1000);
                let mut exit_code = 0;
                let query = GetExitCodeProcess(handle, &mut exit_code);
                let _ = CloseHandle(handle);
                if wait == WAIT_OBJECT_0 && query.is_ok() && exit_code != 0 {
                    // 正常退出/身份切换使用退出码 0；仅异常退出时恢复。
                    if let Ok(exe) = std::env::current_exe() {
                        use std::os::windows::process::CommandExt;
                        const DETACHED_PROCESS: u32 = 0x0000_0008;
                        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
                        let _ = std::process::Command::new(&exe)
                            .env_remove(crate::disguise::PARENT)
                            .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
                            .spawn();
                    }
                }
            }
        }
    }
}
