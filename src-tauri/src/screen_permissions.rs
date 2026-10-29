//! Screen recording permission flow. The OS grant is the source of truth.

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
