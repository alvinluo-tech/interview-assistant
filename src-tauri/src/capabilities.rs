use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    platform: String,
    system_audio: bool,
    screen_capture: bool,
    cursor_zones: bool,
    window_title: bool,
    process_rename: bool,
    output_device_exclusion: bool,
    capture_protection: &'static str,
}

fn for_platform(platform: &str, major: u32) -> Capabilities {
    let windows = platform == "windows";
    let mac = platform == "macos";
    Capabilities { platform: platform.into(), system_audio: windows || (mac && major >= 13), screen_capture: windows || (mac && major >= 13),
        cursor_zones: windows || mac, window_title: windows || mac, process_rename: windows, output_device_exclusion: windows,
        capture_protection: if windows { "windowsAffinity" } else if mac { "bestEffort" } else { "unsupported" } }
}

#[tauri::command]
pub fn cmd_platform_capabilities() -> Result<Capabilities, String> {
    #[cfg(target_os = "macos")]
    let major = {
        let result = std::process::Command::new("/usr/bin/sw_vers").arg("-productVersion").output().map_err(|e| format!("无法读取 macOS 版本：{e}"))?;
        if !result.status.success() { return Err("无法读取 macOS 版本".into()); }
        String::from_utf8_lossy(&result.stdout).trim().split('.').next().and_then(|s| s.parse::<u32>().ok()).ok_or("macOS 版本格式无效")?
    };
    #[cfg(not(target_os = "macos"))]
    let major = 0;
    Ok(for_platform(std::env::consts::OS, major))
}

#[cfg(test)]
mod tests {
    use super::for_platform;

    #[test]
    fn mac_requires_13_for_capture_and_reports_only_best_effort_protection() {
        let old = for_platform("macos", 12);
        assert!(!old.system_audio && !old.screen_capture);
        let mac = for_platform("macos", 13);
        assert!(mac.system_audio && mac.screen_capture && mac.cursor_zones && mac.window_title);
        assert!(!mac.process_rename && !mac.output_device_exclusion);
        assert_eq!(mac.capture_protection, "bestEffort");
        let windows = for_platform("windows", 10);
        assert!(windows.system_audio && windows.output_device_exclusion && windows.process_rename);
        assert_eq!(windows.capture_protection, "windowsAffinity");
        let other = for_platform("linux", 6);
        assert!(!other.system_audio && !other.screen_capture && !other.window_title);
    }
}
