//! ScreenCaptureKit owns its Swift bridge. This module owns each stream and
//! hands only bounded, owned Rust buffers to consumers, never native pointers.
use crate::media::{
    AudioFormat, AudioPlane, AudioPlayout, PcmChunks, SampleKind, bgra_to_rgba, decode_audio,
};
use crate::selection::{WindowCandidate, choose_window};
use core_graphics::{
    display::CGDisplay,
    event::CGEvent,
    event_source::{CGEventSource, CGEventSourceStateID},
    window,
};
use screencapturekit::prelude::*;
use screencapturekit::{SCFrameStatus, cv::CVPixelBufferLockFlags};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::time::{Duration, Instant};

fn error(error: impl std::fmt::Display) -> String {
    format!("macOS 采集失败：{error}")
}
type StreamFailure = Arc<Mutex<Option<String>>>;
fn fail(slot: &StreamFailure, message: String) {
    if let Ok(mut slot) = slot.lock() {
        if slot.is_none() {
            *slot = Some(message);
        }
    }
}

// Always stop on success, error, cancellation, or timeout. Native completion
// waits are bounded by the library; this owner lives off the UI thread.
struct StreamOwner(SCStream);
impl Drop for StreamOwner {
    fn drop(&mut self) {
        let _ = self.0.stop_capture();
    }
}

struct OwnedPlane {
    channels: usize,
    data: Vec<u8>,
}
struct AudioPacket {
    format: AudioFormat,
    frames: usize,
    planes: Vec<OwnedPlane>,
}

fn audio_packet(sample: &CMSampleBuffer) -> Result<Option<AudioPacket>, String> {
    let frames = usize::try_from(sample.num_samples()).map_err(|_| "系统收音采样数无效")?;
    if frames == 0 {
        return Ok(None);
    }
    let description = sample.format_description().ok_or("系统收音缺少格式信息")?;
    if description.media_subtype_raw() != u32::from_be_bytes(*b"lpcm") {
        return Err("系统收音返回了非 PCM 格式".into());
    }
    let rate = description
        .audio_sample_rate()
        .ok_or("系统收音缺少采样率")?;
    if !rate.is_finite()
        || rate.fract() != 0.0
        || !(16000.0..=192000.0).contains(&rate)
        || frames > rate as usize / 4
    {
        return Err("系统收音采样率或单包长度不受支持".into());
    }
    let flags = description
        .audio_format_flags()
        .ok_or("系统收音缺少格式标记")?;
    let bits = description
        .audio_bits_per_channel()
        .ok_or("系统收音缺少位深")?;
    let kind = match (flags & 1 != 0, bits, flags & 4 != 0) {
        (true, 32, _) => SampleKind::Float32,
        (true, 64, _) => SampleKind::Float64,
        (false, 16, true) => SampleKind::Signed16,
        (false, 24, true) => SampleKind::Signed24,
        (false, 32, true) => SampleKind::Signed32,
        _ => return Err("系统收音 PCM 位深不受支持".into()),
    };
    if flags & 8 == 0 || flags & 16 != 0 {
        return Err("系统收音 PCM 对齐方式不受支持".into());
    }
    let format = AudioFormat {
        rate: rate as u32,
        channels: description
            .audio_channel_count()
            .ok_or("系统收音缺少声道信息")? as usize,
        kind,
        big_endian: flags & 2 != 0,
        planar: flags & 32 != 0,
        bytes_per_frame: description
            .audio_bytes_per_frame()
            .ok_or("系统收音缺少帧长度")? as usize,
    };
    if !(1..=8).contains(&format.channels) || format.bytes_per_frame > 64 {
        return Err("系统收音声道或帧长度无效".into());
    }
    let buffers = sample.audio_buffer_list().map_err(error)?;
    if buffers.num_buffers() > 8 {
        return Err("系统收音缓冲区过多".into());
    }
    let mut planes = Vec::new();
    for buffer in buffers.iter() {
        if buffer.data().len() > frames * format.bytes_per_frame {
            return Err("系统收音缓冲区长度不匹配".into());
        }
        planes.push(OwnedPlane {
            channels: buffer.number_channels as usize,
            data: buffer.data().to_vec(),
        });
    }
    Ok(Some(AudioPacket {
        format,
        frames,
        planes,
    }))
}

/// Blocking worker entry. The caller cancels with `stop`; callbacks from a
/// cancelled stream never deliver audio into a replacement session.
pub fn capture_audio(
    stop: Arc<AtomicBool>,
    ready: impl FnOnce(),
    mut emit: impl FnMut(&[i16]),
) -> Result<(), String> {
    let content = SCShareableContent::get().map_err(error)?;
    if stop.load(Ordering::Acquire) {
        return Ok(());
    }
    let display = content
        .displays()
        .into_iter()
        .find(|d| d.display_id() == CGDisplay::main().id)
        .or_else(|| content.displays().into_iter().next())
        .ok_or("未找到可采集的显示器")?;
    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_excluding_windows(&[])
        .build()
        .map_err(error)?;
    let config = SCStreamConfiguration::new()
        .with_width(2)
        .with_height(2)
        .with_minimum_frame_interval(&CMTime::new(1, 1))
        .with_queue_depth(3)
        .with_captures_audio(true)
        .with_sample_rate(16000)
        .with_channel_count(1)
        .with_excludes_current_process_audio(true);
    let failure: StreamFailure = Arc::new(Mutex::new(None));
    let failed = failure.clone();
    let mut stream = StreamOwner(
        SCStream::new_with_delegate(
            &filter,
            &config,
            ErrorHandler::new(move |e| fail(&failed, error(e))),
        )
        .map_err(error)?,
    );
    // At most two seconds of 250ms packets. Callback never waits for a consumer.
    let (tx, rx) = mpsc::sync_channel(8);
    let cancelled = stop.clone();
    let failed = failure.clone();
    stream
        .0
        .add_output_handler(
            move |sample: CMSampleBuffer, ty| {
                if ty != SCStreamOutputType::Audio || cancelled.load(Ordering::Acquire) {
                    return;
                }
                match audio_packet(&sample) {
                    Ok(Some(packet)) => {
                        if let Err(e) = tx.try_send(packet) {
                            if matches!(e, mpsc::TrySendError::Full(_)) {
                                fail(&failed, "系统收音处理队列已满，请暂停后重试。".into());
                            }
                        }
                    }
                    Ok(None) => {}
                    Err(e) => fail(&failed, e),
                }
            },
            SCStreamOutputType::Audio,
        )
        .map_err(error)?;
    stream.0.start_capture().map_err(error)?;
    if stop.load(Ordering::Acquire) {
        return Ok(());
    }
    ready();
    let mut converter: Option<(AudioFormat, PcmChunks)> = None;
    let started = Instant::now();
    let mut last_packet = started;
    let mut playout = AudioPlayout::new();
    while !stop.load(Ordering::Acquire) {
        if let Some(message) = failure.lock().map_err(|_| "系统收音状态不可用")?.take() {
            return Err(message);
        }
        match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(packet) => {
                last_packet = Instant::now();
                if converter
                    .as_ref()
                    .is_none_or(|(format, _)| *format != packet.format)
                {
                    converter = Some((packet.format, PcmChunks::new(packet.format.rate)?));
                }
                let planes: Vec<_> = packet
                    .planes
                    .iter()
                    .map(|p| AudioPlane {
                        channels: p.channels,
                        data: &p.data,
                    })
                    .collect();
                let mono = decode_audio(packet.format, &planes, packet.frames)?;
                playout.push(converter.as_mut().unwrap().1.push(&mono))?;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err("系统收音数据流已关闭".into()),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        // Allow the largest accepted 250ms callback plus scheduling slack;
        // shorter pauses must not pad an otherwise continuous packet stream.
        if last_packet.elapsed() >= Duration::from_millis(350) {
            if let Some((_, converter)) = &mut converter {
                if let Some(tail) = converter.flush() {
                    playout.push(vec![tail])?;
                }
            }
        }
        // ScreenCaptureKit can omit callbacks when no app is playing sound.
        // Keep the ASR heartbeat with silence, not repeated old speech.
        if let Some(chunk) = playout.tick(started.elapsed().as_millis() as u64)? {
            if stop.load(Ordering::Acquire) {
                return Ok(());
            }
            emit(&chunk);
        }
    }
    Ok(())
}

pub struct CapturedImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

fn target(
    content: &SCShareableContent,
    window_mode: bool,
) -> Result<(SCContentFilter, u32, u32), String> {
    let displays = content.displays();
    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
        .map_err(|_| "无法获取截图目标位置")?;
    let cursor = CGEvent::new(source)
        .map_err(|_| "无法获取截图目标位置")?
        .location();
    let display = displays
        .iter()
        .find(|d| {
            let r = d.frame();
            cursor.x >= r.origin.x
                && cursor.y >= r.origin.y
                && cursor.x < r.origin.x + r.size.width
                && cursor.y < r.origin.y + r.size.height
        })
        .or_else(|| {
            displays
                .iter()
                .find(|d| d.display_id() == CGDisplay::main().id)
        })
        .ok_or("未找到可截图的显示器")?;
    if !window_mode {
        let own: Vec<_> = content
            .applications()
            .into_iter()
            .filter(|a| a.process_id() as u32 == std::process::id())
            .collect();
        let own_refs: Vec<_> = own.iter().collect();
        let filter = SCContentFilter::create()
            .with_display(display)
            .with_excluding_applications(&own_refs, &[])
            .build()
            .map_err(error)?;
        return Ok((filter, display.width(), display.height()));
    }
    let windows = content.windows();
    let candidates: Vec<_> = windows
        .iter()
        .map(|w| WindowCandidate {
            id: w.window_id(),
            pid: w
                .owning_application()
                .map(|a| a.process_id() as u32)
                .unwrap_or(0),
            layer: w.window_layer(),
            visible: w.is_on_screen(),
            width: w.frame().size.width,
            height: w.frame().size.height,
        })
        .collect();
    let order = window::create_window_list(
        window::kCGWindowListOptionOnScreenOnly | window::kCGWindowListExcludeDesktopElements,
        0,
    )
    .ok_or("无法读取前台窗口顺序")?;
    let ids: Vec<u32> = order.iter().map(|id| *id).collect();
    let id = choose_window(&ids, &candidates, std::process::id())?;
    let selected = windows
        .iter()
        .find(|w| w.window_id() == id)
        .ok_or("题目窗口已关闭")?;
    let r = selected.frame();
    let source_display = displays
        .iter()
        .find(|d| {
            let d = d.frame();
            let x = r.origin.x + r.size.width / 2.0;
            let y = r.origin.y + r.size.height / 2.0;
            x >= d.origin.x
                && y >= d.origin.y
                && x < d.origin.x + d.size.width
                && y < d.origin.y + d.size.height
        })
        .unwrap_or(display);
    let scale = source_display.width() as f64 / source_display.frame().size.width;
    let width = (r.size.width * scale).ceil() as u32;
    let height = (r.size.height * scale).ceil() as u32;
    let filter = SCContentFilter::create()
        .with_window(selected)
        .build()
        .map_err(error)?;
    Ok((filter, width, height))
}

/// A separate one-frame stream works on macOS 13 and never stops system audio.
/// Window mode errors stay errors; it never expands the requested capture scope.
pub fn capture_image(window_mode: bool) -> Result<CapturedImage, String> {
    let content = SCShareableContent::get().map_err(error)?;
    let (filter, width, height) = target(&content, window_mode)?;
    if width == 0 || height == 0 || width as u64 * height as u64 > 32_000_000 {
        return Err("截图尺寸无效或过大".into());
    }
    let config = SCStreamConfiguration::new()
        .with_width(width)
        .with_height(height)
        .with_pixel_format(PixelFormat::BGRA)
        .with_queue_depth(3)
        .with_minimum_frame_interval(&CMTime::new(1, 5))
        .with_captures_audio(false);
    let (tx, rx) = mpsc::sync_channel(1);
    let failed = tx.clone();
    let mut stream = StreamOwner(
        SCStream::new_with_delegate(
            &filter,
            &config,
            ErrorHandler::new(move |e| {
                let _ = failed.try_send(Err(error(e)));
            }),
        )
        .map_err(error)?,
    );
    let sent = AtomicBool::new(false);
    stream
        .0
        .add_output_handler(
            move |sample: CMSampleBuffer, ty| {
                if ty != SCStreamOutputType::Screen
                    || sample.frame_status() != Some(SCFrameStatus::Complete)
                    || sent.load(Ordering::Acquire)
                {
                    return;
                }
                let Some(buffer) = sample.pixel_buffer() else {
                    return;
                };
                if buffer.pixel_format() != u32::from_be_bytes(*b"BGRA") {
                    return;
                }
                let Ok(guard) = buffer.lock(CVPixelBufferLockFlags::READ_ONLY) else {
                    return;
                };
                if sent.swap(true, Ordering::AcqRel) {
                    return;
                }
                // SAFETY: read-only BGRA buffer, locked for this synchronous copy. No
                // pointer/slice survives the guard or enters an async channel.
                let result = unsafe { guard.as_slice() }
                    .ok_or_else(|| "截图像素缓冲区为空".to_string())
                    .and_then(|data| {
                        bgra_to_rgba(data, guard.width(), guard.height(), guard.bytes_per_row())
                            .map(|rgba| CapturedImage {
                                width: guard.width() as u32,
                                height: guard.height() as u32,
                                rgba,
                            })
                    });
                let _ = tx.try_send(result);
            },
            SCStreamOutputType::Screen,
        )
        .map_err(error)?;
    stream.0.start_capture().map_err(error)?;
    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|_| "截图超时，请检查屏幕录制权限后重试。".to_string())?
}
