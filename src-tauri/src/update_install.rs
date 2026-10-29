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
