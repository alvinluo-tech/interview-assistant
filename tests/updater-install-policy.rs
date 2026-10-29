#[path = "../src-tauri/src/update_install.rs"]
mod policy;
use policy::{InstallMode, windows_mode, stage_verified_installer};
use std::{fs, path::PathBuf, time::{SystemTime, UNIX_EPOCH}};

fn fixture() -> PathBuf {
    let root = std::env::temp_dir().join(format!("mianxu-updater-policy-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    fs::create_dir(&root).unwrap();
    root
}
const NONCE: &str = "0123456789abcdef0123456789abcdef";

#[test]
fn development_and_portable_windows_builds_use_installer_handoff() {
    assert_eq!(windows_mode(true, false, false), InstallMode::Installer);
    assert_eq!(windows_mode(true, true, false), InstallMode::Installer);
    assert_eq!(windows_mode(false, false, false), InstallMode::Installer);
    assert_eq!(windows_mode(false, true, false), InstallMode::Managed);
    for debug in [true, false] {
        assert_eq!(windows_mode(debug, true, true), InstallMode::Restore);
    }
    assert!(InstallMode::Installer.can_install());
    assert!(InstallMode::Managed.can_install());
    assert!(!InstallMode::Restore.can_install());
    assert!(!InstallMode::Unavailable.can_install());
}

#[test]
fn only_an_explicit_install_call_stages_and_hands_off_verified_bytes() {
    let root = fixture();
    let bytes = b"already verified by the signed updater download";
    let path = stage_verified_installer(&root, NONCE, bytes, |file| {
        assert_eq!(fs::read(file)?, bytes);
        assert_eq!(file.file_name().unwrap(), "Mianxu-setup.exe");
        assert_eq!(file.parent().unwrap().parent().unwrap(), root);
        Ok(())
    }).unwrap();
    assert_eq!(fs::read(&path).unwrap(), bytes);
    // An existing random directory must never be reused or overwritten.
    assert!(stage_verified_installer(&root, NONCE, b"replacement", |_| panic!("must not launch")).is_err());
    assert_eq!(fs::read(path).unwrap(), bytes);
}

#[test]
fn invalid_inputs_and_launch_errors_never_leave_an_executable_ready_to_reuse() {
    let root = fixture();
    for nonce in ["", "../escape", "z123456789abcdef0123456789abcdef"] {
        assert!(stage_verified_installer(&root, nonce, b"payload", |_| panic!("must not launch")).is_err());
    }
    assert!(stage_verified_installer(&root, NONCE, b"", |_| panic!("must not launch")).is_err());
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    assert!(stage_verified_installer(&root, NONCE, b"payload", |_| Err(std::io::Error::other("cannot start"))).is_err());
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    let blocked_root = root.join("not-a-directory");
    fs::write(&blocked_root, b"keep").unwrap();
    assert!(stage_verified_installer(&blocked_root, NONCE, b"payload", |_| panic!("must not launch")).is_err());
    assert_eq!(fs::read(blocked_root).unwrap(), b"keep");
}

#[test]
fn modes_have_stable_frontend_names() {
    assert_eq!(InstallMode::Managed.as_str(), "managed");
    assert_eq!(InstallMode::Installer.as_str(), "installer");
    assert_eq!(InstallMode::Restore.as_str(), "restore");
    assert_eq!(InstallMode::Unavailable.as_str(), "unavailable");
}
