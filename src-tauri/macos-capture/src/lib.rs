//! macOS capture backend and platform-independent media validation.

pub mod media;
pub mod selection;

#[cfg(target_os = "macos")]
mod native;
#[cfg(target_os = "macos")]
pub use native::{capture_audio, capture_image, CapturedImage};

#[cfg(target_os = "macos")]
pub mod window;

#[cfg(test)]
mod tests;
