//! Installation destination policy and a Windows installer handoff. Call staging
//! only with bytes returned by the updater's successful signature verification.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallMode { Managed, Installer, Restore, Unavailable }
impl InstallMode {
    pub fn can_install(self) -> bool { matches!(self, Self::Managed | Self::Installer) }
    pub fn as_str(self) -> &'static str {
        match self { Self::Managed => "managed", Self::Installer => "installer", Self::Restore => "restore", Self::Unavailable => "unavailable" }
    }
}

#[cfg(any(windows, test))]
pub fn windows_mode(debug: bool, installed: bool, disguised: bool) -> InstallMode {
    if disguised { InstallMode::Restore }
    else if !debug && installed { InstallMode::Managed }
    else { InstallMode::Installer }
}

/// 安装包按随机目录缓存，成功启动向导后无法立刻删除（Windows 仍锁着 exe）。
/// 超过一小时的旧目录会在下次更新时回收，避免缓存里越积越多。
#[cfg(any(windows, test))]
pub fn prune_stale_installers(cache: &std::path::Path, keep: &str, now: std::time::SystemTime) {
    use std::time::Duration;
    let Ok(entries) = std::fs::read_dir(cache) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy() == keep {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let stale = meta.is_dir()
            && meta
                .modified()
                .ok()
                .and_then(|at| now.duration_since(at).ok())
                .is_some_and(|age| age >= Duration::from_secs(3600));
        if stale {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(any(windows, test))]
pub fn stage_verified_installer(
    cache: &std::path::Path,
    nonce: &str,
    verified_bytes: &[u8],
    launch: impl FnOnce(&std::path::Path) -> std::io::Result<()>,
) -> std::io::Result<std::path::PathBuf> {
    use std::{fs, io::{Error, ErrorKind, Write}};
    if nonce.len() != 32 || !nonce.bytes().all(|c| c.is_ascii_hexdigit()) || verified_bytes.is_empty() {
        return Err(Error::new(ErrorKind::InvalidInput, "Invalid verified installer staging request"));
    }
    fs::create_dir_all(cache)?;
    prune_stale_installers(cache, nonce, std::time::SystemTime::now());
    let directory = cache.join(nonce);
    fs::create_dir(&directory)?; // Never reuse a path or overwrite another task's file.
    let file = directory.join("Mianxu-setup.exe");
    let result = (|| {
        let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&file)?;
        output.write_all(verified_bytes)?;
        output.sync_all()?;
        drop(output);
        launch(&file)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&file);
        let _ = fs::remove_dir(&directory);
        return Err(error);
    }
    Ok(file)
}
