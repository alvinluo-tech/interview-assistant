# Local Tao patch

Based on the crates.io release `tao` 0.37.2. The macOS backend recognizes the
reserved tabbing identifier `com.luoyaosheng.mianxu.overlay-panel` as a
creation-time marker and creates an NSPanel with the non-activating style. The
marker is not passed to AppKit as a tabbing identifier. Other windows remain
NSWindow instances. Focusability and drag event handling retain Tao's behavior.
The NSWindow/NSPanel implementations share the same focusable state without
changing an existing Objective-C object's class or lifetime.

Review this patch when upgrading Tao, and remove it if upstream provides an
appropriate per-window non-activating panel API. Tao is Apache-2.0 licensed;
see LICENSE and LICENSE.spdx.
