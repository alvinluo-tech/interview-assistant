//! Screen recording permission flow. The OS grant is the source of truth.

fn request_access(check: impl Fn() -> bool, prompt: impl FnOnce()) -> bool {
    if check() {
        return true;
    }
    prompt();
    // Opening a prompt/settings does not mean that the app can capture yet.
    check()
}

#[cfg(target_os = "macos")]
mod native {
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    pub fn check() -> bool {
        // SAFETY: no parameters or borrowed objects; available since macOS 10.15.
        unsafe { CGPreflightScreenCaptureAccess() }
    }

    pub fn request() -> bool {
        super::request_access(check, || {
            // SAFETY: same availability as preflight. Only called by an explicit
            // permission command, never during application startup.
            unsafe { CGRequestScreenCaptureAccess() };
        })
    }

    pub fn open_settings() -> bool {
        // Fixed executable and URL: no shell, user input, or permission reset.
        std::process::Command::new("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .status()
            .is_ok_and(|status| status.success())
    }
}

#[cfg(target_os = "macos")]
pub use native::{check, open_settings, request};

#[cfg(test)]
mod tests {
    use super::request_access;
    use std::cell::Cell;

    #[test]
    fn an_existing_grant_does_not_prompt_again() {
        assert!(request_access(|| true, || panic!("unexpected prompt")));
    }

    #[test]
    fn requesting_permission_rechecks_the_effective_grant() {
        let granted = Cell::new(false);
        let prompts = Cell::new(0);
        assert!(request_access(
            || granted.get(),
            || {
                prompts.set(prompts.get() + 1);
                granted.set(true);
            },
        ));
        assert_eq!(prompts.get(), 1);
    }

    #[test]
    fn a_denied_or_pending_grant_stays_unavailable() {
        let prompts = Cell::new(0);
        assert!(!request_access(|| false, || prompts.set(prompts.get() + 1)));
        assert_eq!(prompts.get(), 1);
    }

    #[test]
    fn permission_revocation_is_not_hidden_by_a_cached_success() {
        let granted = Cell::new(true);
        assert!(request_access(|| granted.get(), || {}));
        granted.set(false);
        assert!(!request_access(|| granted.get(), || {}));
    }
}
