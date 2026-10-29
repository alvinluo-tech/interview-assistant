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
