use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager, Window};
use tauri_plugin_store::StoreExt;

const MARKER: &str = "MIANSHI_DISGUISED";
const REAL_EXE: &str = "MIANSHI_REAL_EXE";
pub(crate) const PARENT: &str = "MIANSHI_RELAUNCH_PARENT";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub enabled: bool,
    pub process_name: String,
    pub window_title: String,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            process_name: "DesktopHelper".into(),
            window_title: "Desktop Helper".into(),
        }
    }
}

pub fn normalize_name(input: &str) -> Result<String, String> {
    let input = input.trim();
    let mut name = input;
    while name
        .get(name.len().saturating_sub(4)..)
        .is_some_and(|s| s.eq_ignore_ascii_case(".exe"))
    {
        name = &name[..name.len() - 4];
    }
    if name.is_empty()
        || name.len() > 40
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b" -._".contains(&c))
    {
        return Err("进程名需为 1–40 个英文字母、数字、空格或 - . _".into());
    }
    if name.ends_with([' ', '.']) || name.starts_with('.') {
        return Err("进程名不能以点开头，或以空格、点结尾".into());
    }
    let device = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL"].contains(&device.as_str())
        || (device.len() == 4
            && (device.starts_with("COM") || device.starts_with("LPT"))
            && matches!(device.as_bytes()[3], b'1'..=b'9'))
    {
        return Err("进程名不能使用 Windows 保留设备名".into());
    }
    Ok(name.into())
}

impl Config {
    fn normalized(mut self) -> Result<Self, String> {
        self.process_name = normalize_name(&self.process_name)?;
        self.window_title = self.window_title.trim().into();
        if self.window_title.is_empty()
            || self.window_title.chars().count() > 128
            || self.window_title.chars().any(char::is_control)
        {
            return Err("窗口标题需为 1–128 个字符，且不能含控制字符".into());
        }
        Ok(self)
    }
    fn from_json(value: &serde_json::Value) -> Result<Self, String> {
        let default = Self::default();
        Self {
            enabled: value
                .get("disguise.enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            process_name: value
                .get("disguise.processName")
                .and_then(|v| v.as_str())
                .unwrap_or(&default.process_name)
                .into(),
            window_title: value
                .get("disguise.windowTitle")
                .and_then(|v| v.as_str())
                .unwrap_or(&default.window_title)
                .into(),
        }
        .normalized()
    }
    fn entries(&self) -> [(&'static str, serde_json::Value); 3] {
        [
            ("disguise.enabled", self.enabled.into()),
            ("disguise.processName", self.process_name.clone().into()),
            ("disguise.windowTitle", self.window_title.clone().into()),
        ]
    }
}

#[derive(Default)]
pub struct DisguiseState {
    config: Mutex<Config>,
    pub startup_error: Mutex<Option<String>>,
}

pub fn initialize(app: &AppHandle) -> Result<(), String> {
    let store = app.store("store.json").map_err(|e| e.to_string())?;
    let value = serde_json::json!({
        "disguise.enabled": store.get("disguise.enabled"),
        "disguise.processName": store.get("disguise.processName"),
        "disguise.windowTitle": store.get("disguise.windowTitle"),
    });
    let config = Config::from_json(&value)?;
    *app.state::<DisguiseState>()
        .config
        .lock()
        .map_err(|e| e.to_string())? = config;
    for label in crate::protection::LABELS {
        if let Some(window) = crate::protection::window(app, label) {
            reapply(&window)?;
        }
    }
    Ok(())
}

fn apply_identity(window: &Window, config: &Config) -> Result<(), String> {
    let default = window
        .app_handle()
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == window.label())
        .map(|w| w.title.as_str())
        .unwrap_or("骆耀升老公酱面试助手");
    window
        .set_title(if config.enabled {
            &config.window_title
        } else {
            default
        })
        .map_err(|e| e.to_string())?;
    #[cfg(windows)]
    if config.enabled {
        use windows::Win32::{
            Foundation::{LPARAM, WPARAM},
            UI::WindowsAndMessaging::{IDI_APPLICATION, LoadIconW, SendMessageW, WM_SETICON},
        };
        let icon = unsafe { LoadIconW(None, IDI_APPLICATION) }.map_err(|e| e.to_string())?;
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        // The shared system icon must not be destroyed by the application.
        for size in [0, 1] {
            unsafe {
                SendMessageW(
                    hwnd,
                    WM_SETICON,
                    Some(WPARAM(size)),
                    Some(LPARAM(icon.0 as isize)),
                )
            };
        }
    } else if let Some(icon) = window.app_handle().default_window_icon() {
        window.set_icon(icon.clone()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn reapply(window: &Window) -> Result<(), String> {
    if !crate::protection::LABELS.contains(&window.label()) {
        return Ok(());
    }
    let Some(state) = window.app_handle().try_state::<DisguiseState>() else {
        return Ok(());
    };
    let config = state.config.lock().map_err(|e| e.to_string())?.clone();
    apply_identity(window, &config)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    supported: bool,
    process_rename_supported: bool,
    config: Config,
    current_exe: String,
    running_disguised: bool,
    restart_required: bool,
    startup_error: Option<String>,
}

#[tauri::command]
pub fn cmd_get_disguise_status(app: AppHandle) -> Result<Status, String> {
    let state = app.state::<DisguiseState>();
    let config = state.config.lock().map_err(|e| e.to_string())?.clone();
    let current = std::env::current_exe().map_err(|e| e.to_string())?;
    let running_disguised = cfg!(windows) && is_copy(&current, &app.config().identifier);
    let restart_required = cfg!(windows) && if config.enabled {
        !running_disguised || !matches_name(&current, &config.process_name)
    } else {
        running_disguised
    };
    Ok(Status {
        supported: cfg!(any(windows, target_os = "macos")),
        process_rename_supported: cfg!(windows),
        config,
        current_exe: current.display().to_string(),
        running_disguised,
        restart_required,
        startup_error: state
            .startup_error
            .lock()
            .map_err(|e| e.to_string())?
            .clone(),
    })
}

#[tauri::command]
pub fn cmd_set_disguise(app: AppHandle, config: Config) -> Result<Status, String> {
    if !cfg!(any(windows, target_os = "macos")) {
        return Err("当前平台不支持窗口身份设置".into());
    }
    let config = config.normalized()?;
    let state = app.state::<DisguiseState>();
    let mut current = state.config.lock().map_err(|e| e.to_string())?;
    let windows: Vec<_> = crate::protection::LABELS
        .into_iter()
        .filter_map(|label| crate::protection::window(&app, label))
        .collect();
    let result = (|| {
        for window in &windows {
            apply_identity(window, &config)?;
        }
        crate::settings::save(&app, &config.entries())
    })();
    if let Err(mut error) = result {
        for window in &windows {
            if let Err(rollback) = apply_identity(window, &current) {
                error.push_str(&format!("；恢复窗口身份失败：{rollback}"));
            }
        }
        return Err(error);
    }
    *current = config;
    drop(current);
    cmd_get_disguise_status(app)
}

fn matches_name(path: &Path, name: &str) -> bool {
    path.file_name().is_some_and(|s| {
        s.to_string_lossy()
            .eq_ignore_ascii_case(&format!("{name}.exe"))
    })
}
fn copy_dir(identifier: &str) -> Option<PathBuf> {
    dirs::data_local_dir().map(|root| root.join(identifier).join("disguise"))
}
fn is_copy(path: &Path, identifier: &str) -> bool {
    std::env::var_os(MARKER).is_some()
        || copy_dir(identifier).is_some_and(|dir| path.parent().is_some_and(|parent| parent == dir))
}
fn real_exe(current: &Path, identifier: &str) -> Result<PathBuf, String> {
    if !is_copy(current, identifier) {
        return Ok(current.into());
    }
    let path = std::env::var_os(REAL_EXE)
        .map(PathBuf::from)
        .or_else(|| {
            // Allows a copied exe launched directly after logout/reboot to find the original.
            let value: PathBuf = serde_json::from_slice(
                &std::fs::read(copy_dir(identifier)?.join("origin.json")).ok()?,
            )
            .ok()?;
            Some(value)
        })
        .ok_or("找不到原始程序路径，无法恢复；请从原安装位置启动")?;
    if !path.is_file()
        || path == current
        || path
            .extension()
            .is_none_or(|e| !e.eq_ignore_ascii_case("exe"))
    {
        return Err("原始程序不存在或路径无效；请从原安装位置启动".into());
    }
    Ok(path)
}

#[cfg(windows)]
fn spawn_handoff(target: &Path, original: &Path, disguised: bool) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow;
    let mut command = std::process::Command::new(target);
    command
        .args(std::env::args_os().skip(1))
        .env(PARENT, std::process::id().to_string());
    if disguised {
        command.env(MARKER, "1").env(REAL_EXE, original);
    } else {
        command.env_remove(MARKER).env_remove(REAL_EXE);
    }
    let child = command.spawn().map_err(|e| format!("重启程序失败：{e}"))?;
    let _ = unsafe { AllowSetForegroundWindow(child.id()) };
    Ok(())
}

/// Child waits for the old single-instance mutex to be released before initializing Tauri.
#[cfg(windows)]
pub fn wait_for_handoff() -> Result<(), String> {
    use windows::Win32::{
        Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0},
        System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
    };
    let Some(pid) = std::env::var_os(PARENT) else {
        return Ok(());
    };
    let pid: u32 = pid
        .to_str()
        .and_then(|s| s.parse().ok())
        .ok_or("无效重启进程 ID")?;
    if pid == std::process::id() {
        return Err("不能等待当前进程退出".into());
    }
    let handle = match unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) } {
        Ok(handle) => handle,
        Err(error)
            if error.code() == windows::core::HRESULT::from_win32(ERROR_INVALID_PARAMETER.0) =>
        {
            return Ok(());
        }
        Err(error) => return Err(format!("等待原进程失败：{error}")),
    };
    let result = unsafe { WaitForSingleObject(handle, 15_000) };
    let _ = unsafe { CloseHandle(handle) };
    if result == WAIT_OBJECT_0 {
        Ok(())
    } else {
        Err("原进程未及时退出，取消重启以免产生重复实例".into())
    }
}

#[cfg(windows)]
pub fn maybe_relaunch(identifier: &str) -> Result<bool, String> {
    // dev 下不做副本切换：tauri dev 的进程树里挂着 Vite，副本接管后原进程退出
    // 会把 dev server 一起带走；调试对象也应该是本体。伪装仅在打包版生效。
    if cfg!(debug_assertions) {
        return Ok(false);
    }
    let path = dirs::data_dir()
        .ok_or("APPDATA 不可用")?
        .join(identifier)
        .join("store.json");
    let config = match std::fs::read(path) {
        Ok(data) => Config::from_json(
            &serde_json::from_slice(&data).map_err(|e| format!("store.json 解析失败：{e}"))?,
        )?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Config::default(),
        Err(error) => return Err(error.to_string()),
    };
    let current = std::env::current_exe().map_err(|e| e.to_string())?;
    if !config.enabled {
        if is_copy(&current, identifier) {
            let original = real_exe(&current, identifier)?;
            spawn_handoff(&original, &original, false)?;
            return Ok(true);
        }
        return Ok(false);
    }
    if is_copy(&current, identifier) && matches_name(&current, &config.process_name) {
        return Ok(false);
    }
    let original = real_exe(&current, identifier)?;
    let dir = copy_dir(identifier).ok_or("LOCALAPPDATA 不可用")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let staged = dir.join(format!("staged-{}.exe", std::process::id()));
    let target = dir.join(format!("{}.exe", config.process_name));
    let result = (|| {
        std::fs::copy(&original, &staged).map_err(|e| format!("复制程序失败：{e}"))?;
        crate::identity_resources::rebrand(&staged, &config.process_name)?;
        // An old guardian can briefly retain an image handle after the parent exits.
        let mut moved = std::fs::rename(&staged, &target);
        for _ in 0..3 {
            if moved.is_ok() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
            moved = std::fs::rename(&staged, &target);
        }
        moved.map_err(|e| format!("保存伪装副本失败（文件可能正被占用）：{e}"))?;
        std::fs::write(
            dir.join("origin.json"),
            serde_json::to_vec(&original).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        spawn_handoff(&target, &original, true)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&staged);
    }
    result.map(|_| true)
}

#[tauri::command]
pub fn cmd_relaunch(app: AppHandle) -> Result<(), String> {
    // Force buffered settings to disk before any child reads store.json.
    app.store("store.json")
        .map_err(|e| e.to_string())?
        .save()
        .map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        let current = std::env::current_exe().map_err(|e| e.to_string())?;
        let original = real_exe(&current, &app.config().identifier)?;
        spawn_handoff(&original, &original, false)?;
        app.exit(0);
    }
    #[cfg(not(windows))]
    app.restart();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_windows_names_and_strips_case_insensitive_extension() {
        assert_eq!(
            normalize_name(" Desktop Helper.EXE ").unwrap(),
            "Desktop Helper"
        );
        assert_eq!(normalize_name("Helper-1.0_x").unwrap(), "Helper-1.0_x");
        assert_eq!(normalize_name("Helper.EXE.exe").unwrap(), "Helper");
        for invalid in [
            "",
            ".exe",
            "..",
            "../escape",
            "C:\\x",
            "测试",
            "CON",
            "nul.data",
            "COM1",
            "LPT9.exe",
            "hello.",
            ".hidden",
        ] {
            assert!(normalize_name(invalid).is_err(), "{invalid}");
        }
        assert!(normalize_name(&"a".repeat(41)).is_err());
    }
    #[test]
    fn reads_compatible_flat_store_keys_and_rejects_bad_titles() {
        let config = Config::from_json(&serde_json::json!({"disguise.enabled":true, "disguise.processName":"Helper.exe", "disguise.windowTitle":"窗口"})).unwrap();
        assert_eq!(config.process_name, "Helper");
        assert!(config.enabled);
        assert!(
            Config {
                window_title: "bad\0title".into(),
                ..Config::default()
            }
            .normalized()
            .is_err()
        );
        assert!(
            Config {
                window_title: "x".repeat(129),
                ..Config::default()
            }
            .normalized()
            .is_err()
        );
    }
}
