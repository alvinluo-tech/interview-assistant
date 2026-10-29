//! Only the main webview can check/download/install signed updates from our fixed manifest.
use serde::Serialize;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_store::StoreExt;
use tauri_plugin_updater::{Update, UpdaterExt};
#[path = "update_install.rs"]
mod install_policy;
use install_policy::InstallMode;

const ENDPOINT: &str = "https://github.com/alvinluo-tech/interview-assistant/releases/latest/download/latest.json";
const PUBLIC_KEY: &str = include_str!("../updater-public-key.txt");

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    phase: String,
    current_version: String,
    version: Option<String>,
    notes: Option<String>,
    date: Option<String>,
    release_url: String,
    downloaded: u64,
    total: Option<u64>,
    busy: bool,
    can_install: bool,
    install_mode: String,
    can_restore_original: bool,
    install_reason: Option<String>,
    error: Option<String>,
    updated_from: Option<String>,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self { phase: "idle".into(), current_version: String::new(), version: None, notes: None,
            date: None, release_url: "https://github.com/alvinluo-tech/interview-assistant/releases/latest".into(),
            downloaded: 0, total: None, busy: false, can_install: false, install_mode: "unavailable".into(), can_restore_original: false,
            install_reason: None, error: None, updated_from: None }
    }
}
#[derive(Default)]
struct Core {
    view: Snapshot,
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
    working: bool,
    last_check: Option<Instant>,
}
#[derive(Default)]
pub struct UpdateState {
    core: Mutex<Core>,
    activity: Mutex<bool>, // true once installation has exclusive ownership
}
impl UpdateState {
    pub(crate) fn activity_guard(&self) -> Result<MutexGuard<'_, bool>, String> {
        let guard = self.activity.lock().map_err(|_| "更新状态不可用")?;
        if *guard { return Err("正在安装更新，请等待应用重启。".into()); }
        Ok(guard)
    }
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" { Ok(()) } else { Err("更新操作仅允许在主窗口执行。".into()) }
}
fn busy(app: &AppHandle) -> bool {
    let overlay = app.state::<crate::overlay::OverlayState>();
    overlay.session_active.load(std::sync::atomic::Ordering::SeqCst)
        || overlay.overlay_visible.load(std::sync::atomic::Ordering::SeqCst)
        || app.state::<crate::audio::AudioCaptureState>().is_active()
        || app.state::<crate::dual_screen::DualState>().has_peer()
        || app.webview_windows().values().any(|w| w.label().starts_with("mock"))
}

fn official_artifact(url: &tauri::Url, version: &str) -> bool {
    url.scheme() == "https" && url.host_str() == Some("github.com")
        && url.port().is_none() && url.username().is_empty() && url.password().is_none()
        && url.query().is_none() && url.fragment().is_none()
        && url.path().starts_with(&format!("/alvinluo-tech/interview-assistant/releases/download/v{version}/"))
}

fn install_location(app: &AppHandle) -> (InstallMode, bool, Option<String>) {
    #[cfg(not(windows))]
    if cfg!(debug_assertions) { return (InstallMode::Unavailable, false, Some("开发测试版请使用正式安装版本进行自动更新。".into())); }
    let Ok(exe) = std::env::current_exe() else { return (InstallMode::Unavailable, false, Some("无法确认程序安装位置。".into())); };
    #[cfg(windows)]
    {
        if crate::disguise::running_copy(&exe, &app.config().identifier) {
            return (InstallMode::Restore, true, Some("当前运行的是进程伪装副本，请先恢复原程序再更新。".into()));
        }
        use winreg::{RegKey, enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY}};
        let key = format!("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{}", app.config().product_name.as_deref().unwrap_or(""));
        let installed = exe.file_name().is_some_and(|name| name.eq_ignore_ascii_case("Mianxu.exe")) && [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE].into_iter().any(|hive| {
            RegKey::predef(hive).open_subkey_with_flags(&key, KEY_READ | KEY_WOW64_64KEY).ok()
                .and_then(|k| k.get_value::<String, _>("InstallLocation").ok())
                .is_some_and(|location| same_install_directory(&exe, std::path::Path::new(location.trim_matches('"'))))
        });
        let mode = install_policy::windows_mode(cfg!(debug_assertions), installed, false);
        let reason = match mode {
            InstallMode::Installer if cfg!(debug_assertions) => Some("当前是开发版，下载并验证后可通过安装向导安装正式版。".into()),
            InstallMode::Installer => Some("当前是免安装版，下载并验证后将打开官方安装向导。".into()),
            _ => None,
        };
        (mode, false, reason)
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        let bundle = exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app"));
        if bundle.is_some_and(|p| !p.starts_with("/Volumes")) { (InstallMode::Managed, false, None) }
        else { (InstallMode::Unavailable, false, Some("请先将应用从 DMG 拖到 Applications，再使用自动更新。".into())) }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    { let _ = (app, exe); (InstallMode::Unavailable, false, Some("当前平台不支持自动安装，请手动下载。".into())) }
}

#[cfg(any(windows, test))]
fn same_install_directory(exe: &std::path::Path, directory: &std::path::Path) -> bool {
    exe.parent().and_then(|p| p.canonicalize().ok()) == directory.canonicalize().ok()
        && directory.join("uninstall.exe").is_file()
        && directory.canonicalize().is_ok()
}

fn snapshot(app: &AppHandle) -> Snapshot {
    let state = app.state::<UpdateState>();
    let mut core = state.core.lock().unwrap();
    if core.view.current_version.is_empty() {
        if let Ok(store) = app.store("store.json") {
            if let Some(pending) = store.get("updates.pending") {
                if pending.get("to").and_then(|v| v.as_str()) == Some(app.package_info().version.to_string().as_str()) {
                    core.view.updated_from = pending.get("from").and_then(|v| v.as_str()).map(str::to_owned);
                    store.delete("updates.pending"); let _ = store.save();
                }
            }
        }
    }
    core.view.current_version = app.package_info().version.to_string();
    core.view.busy = busy(app);
    let (allowed, restore, reason) = install_location(app);
    core.view.can_install = allowed.can_install();
    core.view.install_mode = allowed.as_str().into();
    core.view.can_restore_original = restore;
    core.view.install_reason = reason;
    core.view.clone()
}
fn publish(app: &AppHandle) { let _ = app.emit_to("main", "updater-state", snapshot(app)); }
fn set_phase(app: &AppHandle, phase: &str) {
    app.state::<UpdateState>().core.lock().unwrap().view.phase = phase.into(); publish(app);
}
fn fail(app: &AppHandle, message: String) -> Snapshot {
    { let state = app.state::<UpdateState>(); let mut core = state.core.lock().unwrap();
      core.view.phase = "error".into(); core.view.error = Some(message); core.working = false; }
    publish(app); snapshot(app)
}
fn error_text(error: tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error;
    match error {
        Error::ReleaseNotFound => "尚未发布可用的自动更新清单，请前往官方发布页查看。".into(),
        Error::Minisign(_) | Error::SignedVersionMismatch { .. } | Error::MissingSignedVersion => "更新签名或签名版本验证失败，已阻止安装，请重新下载或前往官方发布页。".into(),
        other => format!("更新失败，请检查网络或稍后重试：{other}"),
    }
}

#[tauri::command]
pub fn cmd_updater_status(app: AppHandle, window: WebviewWindow) -> Result<Snapshot, String> {
    require_main(&window)?;
    Ok(snapshot(&app))
}

#[tauri::command]
pub async fn cmd_updater_check(app: AppHandle, window: WebviewWindow, manual: bool) -> Result<Snapshot, String> {
    require_main(&window)?;
    {
        let state = app.state::<UpdateState>(); let mut core = state.core.lock().unwrap();
        if core.working || core.view.phase == "ready" || core.view.phase == "installing"
            || core.last_check.is_some_and(|at| at.elapsed() < Duration::from_secs(if manual { 15 } else { 6 * 3600 })) {
            drop(core); return Ok(snapshot(&app));
        }
        core.working = true; core.last_check = Some(Instant::now());
        core.view.error = None;
    }
    set_phase(&app, "checking");
    let builder = app.updater_builder().pubkey(PUBLIC_KEY.trim())
        .timeout(Duration::from_secs(20)).on_before_exit(|| {
            #[cfg(windows)] crate::misc::guardian::stop_for_update();
        });
    let updater = match builder.endpoints(vec![ENDPOINT.parse().expect("fixed HTTPS endpoint")]).and_then(|b| b.build()) {
        Ok(updater) => updater, Err(error) => return Ok(fail(&app, error_text(error))),
    };
    let result = updater.check().await;
    {
        let state = app.state::<UpdateState>(); let mut core = state.core.lock().unwrap();
        core.working = false;
        match result {
            Ok(Some(update)) => {
                if !official_artifact(&update.download_url, &update.version) {
                    drop(core); return Ok(fail(&app, "更新下载地址不属于官方 HTTPS 发布路径，已停止。".into()));
                }
                core.view.phase = "available".into(); core.view.version = Some(update.version.clone());
                core.view.notes = update.body.clone(); core.view.date = update.date.map(|d| d.to_string());
                core.view.release_url = format!("https://github.com/alvinluo-tech/interview-assistant/releases/tag/v{}", update.version);
                core.view.downloaded = 0; core.view.total = None; core.bytes = None; core.update = Some(update);
            }
            Ok(None) => { core.view.phase = "upToDate".into(); core.update = None; core.bytes = None; core.view.version = None; }
            Err(error) => { drop(core); return Ok(fail(&app, error_text(error))); }
        }
    }
    publish(&app); Ok(snapshot(&app))
}

#[tauri::command]
pub async fn cmd_updater_download(app: AppHandle, window: WebviewWindow) -> Result<Snapshot, String> {
    require_main(&window)?;
    let location = install_location(&app);
    if !location.0.can_install() { return Err(location.2.unwrap_or_default()); }
    let update = {
        let state = app.state::<UpdateState>(); let mut core = state.core.lock().unwrap();
        if core.working { return Err("已有更新任务正在进行，请稍候。".into()); }
        let update = core.update.clone().ok_or("请先检查更新。")?;
        core.working = true; core.view.downloaded = 0; core.view.error = None; update
    };
    set_phase(&app, "downloading");
    let progress_app = app.clone(); let finish_app = app.clone(); let mut last_emit = Instant::now();
    let result = update.download(move |length, total| {
        { let state = progress_app.state::<UpdateState>(); let mut core = state.core.lock().unwrap();
          core.view.downloaded = core.view.downloaded.saturating_add(length as u64); core.view.total = total; }
        if last_emit.elapsed() >= Duration::from_millis(100) { publish(&progress_app); last_emit = Instant::now(); }
    }, move || set_phase(&finish_app, "verifying")).await;
    match result {
        Ok(bytes) => {
            let state = app.state::<UpdateState>(); let mut core = state.core.lock().unwrap();
            core.bytes = Some(bytes); core.working = false; core.view.phase = "ready".into();
        }
        Err(error) => return Ok(fail(&app, error_text(error))),
    }
    publish(&app); Ok(snapshot(&app))
}

#[tauri::command]
pub async fn cmd_updater_install(app: AppHandle, window: WebviewWindow) -> Result<Snapshot, String> {
    require_main(&window)?;
    // Atomic with native session/audio starts. JS state is never the installation authority.
    {
        let state = app.state::<UpdateState>(); let mut gate = state.activity_guard()?;
        if busy(&app) { return Err("请先结束面试、笔试、录音或手机副屏会话，再安装更新。".into()); }
        let location = install_location(&app);
        if !location.0.can_install() { return Err(location.2.unwrap_or_default()); }
        *gate = true;
    }
    let result = match install_ready(&app).await { Ok(view) => view, Err(error) => fail(&app, error) };
    if result.phase != "installing" { *app.state::<UpdateState>().activity.lock().unwrap() = false; }
    Ok(result)
}
async fn install_ready(app: &AppHandle) -> Result<Snapshot, String> {
    let (update, bytes) = {
        let state = app.state::<UpdateState>(); let mut core = state.core.lock().unwrap();
        if core.working || core.view.phase != "ready" { return Err("更新尚未下载并通过验证。".into()); }
        let update = core.update.clone().ok_or("更新信息已失效，请重新检查。")?;
        let bytes = core.bytes.take().ok_or("下载内容已失效，请重新下载。")?;
        core.working = true; (update, bytes)
    };
    #[cfg(windows)]
    if install_location(app).0 == InstallMode::Installer {
        // A development/portable executable is not an update destination. Launch
        // the signed official installer normally: NEVER use /UPDATE or /D here.
        // NSIS will locate an existing installation or offer its normal directory.
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|e| format!("无法准备安装包：{e}"))?;
        let nonce: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("verified-installers");
        set_phase(app, "installing");
        tauri::async_runtime::spawn_blocking(move || {
            install_policy::stage_verified_installer(&cache, &nonce, &bytes, |file| {
                std::process::Command::new(file).spawn().map(|_| ())
            })
        }).await.map_err(|e| e.to_string())?.map_err(|e| format!("无法启动安装向导，请重试：{e}"))?;
        // Do not record a completed upgrade: the user may cancel this wizard.
        crate::misc::guardian::stop_for_update();
        app.exit(0);
        return Ok(snapshot(app));
    }
    let store = app.store("store.json").map_err(|e| e.to_string())?;
    store.set("updates.pending", serde_json::json!({"from":app.package_info().version.to_string(),"to":update.version}));
    store.save().map_err(|e| e.to_string())?;
    crate::dual_screen::cmd_dual_stop(app.clone(), app.state());
    set_phase(app, "installing");
    let install = tauri::async_runtime::spawn_blocking(move || update.install(bytes)).await.map_err(|e| e.to_string())?;
    if let Err(error) = install { return Ok(fail(app, error_text(error))); }
    #[cfg(not(windows))] app.restart();
    #[cfg(windows)] { Ok(snapshot(app)) }
}

#[tauri::command]
pub fn cmd_updater_restore_original(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    require_main(&window)?;
    let state = app.state::<UpdateState>();
    let _activity = state.activity_guard()?;
    if busy(&app) { return Err("请先结束当前会话。".into()); }
    #[cfg(windows)] { crate::disguise::relaunch_original_for_update(&app) }
    #[cfg(not(windows))] { Err("当前平台不需要恢复 Windows 原程序。".into()) }
}

#[cfg(test)]
#[path = "../../tests/updater-install-policy.rs"]
mod installer_contract_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installation_blocks_new_native_activity_until_released() {
        let state = UpdateState::default();
        *state.activity_guard().unwrap() = true;
        assert!(state.activity_guard().is_err());
        *state.activity.lock().unwrap() = false;
        assert!(state.activity_guard().is_ok());
    }
    #[test]
    fn a_missing_install_directory_never_counts_as_an_installed_app() {
        assert!(!same_install_directory(std::path::Path::new("missing/app.exe"), std::path::Path::new("missing")));
    }
    #[test]
    fn only_matching_official_release_paths_are_downloaded() {
        let valid = "https://github.com/alvinluo-tech/interview-assistant/releases/download/v0.1.2/Mianxu.exe";
        assert!(official_artifact(&valid.parse().unwrap(), "0.1.2"));
        assert!(!official_artifact(&valid.parse().unwrap(), "0.1.3"));
        for value in [valid.replace("github.com", "evil.test"), valid.replace("https:", "http:"),
            valid.replace("github.com", "github.com:8443"), format!("{valid}?token=secret"), format!("{valid}#fragment"),
            valid.replace("github.com", "user:password@github.com")] {
            assert!(!official_artifact(&value.parse().unwrap(), "0.1.2"));
        }
    }
}
