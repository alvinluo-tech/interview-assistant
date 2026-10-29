//! Owned, bounded media conversion. No Apple types escape a native callback.
use std::collections::VecDeque;

pub struct AudioPlayout { pending: VecDeque<Vec<i16>>, next_ms: u64 }
impl Default for AudioPlayout { fn default() -> Self { Self::new() } }
impl AudioPlayout {
    pub fn new() -> Self { Self { pending: VecDeque::new(), next_ms: 150 } }
    pub fn push(&mut self, chunks: Vec<Vec<i16>>) -> Result<(), String> {
        if self.pending.len() + chunks.len() > 20 || chunks.iter().any(|c| c.len() != 1600) {
            return Err("系统收音处理积压或分包无效，请暂停后重试。".into());
        }
        self.pending.extend(chunks);
        Ok(())
    }
    pub fn tick(&mut self, now_ms: u64) -> Result<Option<Vec<i16>>, String> {
        if now_ms < self.next_ms { return Ok(None); }
        if now_ms - self.next_ms > 500 { return Err("系统收音处理已中断，请暂停后重试。".into()); }
        self.next_ms += 100;
        Ok(Some(self.pending.pop_front().unwrap_or_else(|| vec![0; 1600])))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SampleKind {
    Float32,
    Float64,
    Signed16,
    Signed24,
    Signed32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AudioFormat {
    pub rate: u32,
    pub channels: usize,
    pub kind: SampleKind,
    pub big_endian: bool,
    pub planar: bool,
    pub bytes_per_frame: usize,
}

pub struct AudioPlane<'a> {
    pub channels: usize,
    pub data: &'a [u8],
}

pub fn decode_audio(
    format: AudioFormat,
    planes: &[AudioPlane<'_>],
    frames: usize,
) -> Result<Vec<f32>, String> {
    let size = match format.kind {
        SampleKind::Float32 | SampleKind::Signed32 => 4,
        SampleKind::Float64 => 8,
        SampleKind::Signed16 => 2,
        SampleKind::Signed24 => 3,
    };
    if !(8000..=192000).contains(&format.rate)
        || !(1..=8).contains(&format.channels)
        || frames > format.rate as usize * 2
    {
        return Err("系统收音格式或数据长度无效".into());
    }
    let expected_planes = if format.planar { format.channels } else { 1 };
    let plane_channels = if format.planar { 1 } else { format.channels };
    if planes.len() != expected_planes
        || format.bytes_per_frame < plane_channels * size
        || planes.iter().any(|p| {
            p.channels != plane_channels
                || p.data.len() < frames.saturating_mul(format.bytes_per_frame)
        })
    {
        return Err("系统收音数据不完整或声道布局不受支持".into());
    }
    let mut out = vec![0.0f32; frames];
    for plane in planes {
        for (frame, mono) in out.iter_mut().enumerate() {
            for channel in 0..plane_channels {
                let start = frame * format.bytes_per_frame + channel * size;
                let bytes = &plane.data[start..start + size];
                let value = match format.kind {
                    SampleKind::Float32 => {
                        let b = bytes.try_into().unwrap();
                        if format.big_endian {
                            f32::from_be_bytes(b) as f64
                        } else {
                            f32::from_le_bytes(b) as f64
                        }
                    }
                    SampleKind::Float64 => {
                        let b = bytes.try_into().unwrap();
                        if format.big_endian {
                            f64::from_be_bytes(b)
                        } else {
                            f64::from_le_bytes(b)
                        }
                    }
                    SampleKind::Signed16 => {
                        let b = bytes.try_into().unwrap();
                        (if format.big_endian {
                            i16::from_be_bytes(b)
                        } else {
                            i16::from_le_bytes(b)
                        }) as f64
                            / 32768.0
                    }
                    SampleKind::Signed24 => {
                        let n = if format.big_endian {
                            ((bytes[0] as i32) << 24)
                                | ((bytes[1] as i32) << 16)
                                | ((bytes[2] as i32) << 8)
                        } else {
                            ((bytes[2] as i32) << 24)
                                | ((bytes[1] as i32) << 16)
                                | ((bytes[0] as i32) << 8)
                        };
                        (n >> 8) as f64 / 8388608.0
                    }
                    SampleKind::Signed32 => {
                        let b = bytes.try_into().unwrap();
                        (if format.big_endian {
                            i32::from_be_bytes(b)
                        } else {
                            i32::from_le_bytes(b)
                        }) as f64
                            / 2147483648.0
                    }
                };
                *mono += if value.is_finite() {
                    value.clamp(-1.0, 1.0) as f32 / format.channels as f32
                } else {
                    0.0
                };
            }
        }
    }
    Ok(out)
}

/// Keep phase in integer source-rate units so callback boundaries cannot lose a
/// sample. ScreenCaptureKit's supported rates are all at least 16kHz here.
pub struct PcmChunks {
    rate: u32,
    phase: u64,
    pending: VecDeque<i16>,
}
impl PcmChunks {
    pub fn new(rate: u32) -> Result<Self, String> {
        if !(16000..=192000).contains(&rate) {
            return Err("系统收音采样率不受支持".into());
        }
        Ok(Self {
            rate,
            phase: 0,
            pending: VecDeque::new(),
        })
    }
    pub fn push(&mut self, mono: &[f32]) -> Vec<Vec<i16>> {
        // The stream requests 16kHz; this also preserves duration if macOS
        // negotiates a different rate. One output sample per rational period.
        for value in mono {
            self.phase += 16000;
            if self.phase >= self.rate as u64 {
                self.phase -= self.rate as u64;
                let sample = if value.is_finite() {
                    value.clamp(-1.0, 1.0)
                } else {
                    0.0
                };
                self.pending
                    .push_back((sample * 32768.0).round().clamp(-32768.0, 32767.0) as i16);
            }
        }
        let mut chunks = Vec::new();
        while self.pending.len() >= 1600 {
            chunks.push(self.pending.drain(..1600).collect());
        }
        chunks
    }
}

pub fn bgra_to_rgba(
    data: &[u8],
    width: usize,
    height: usize,
    stride: usize,
) -> Result<Vec<u8>, String> {
    let row = width.checked_mul(4).ok_or("截图尺寸无效")?;
    let pixels = width.checked_mul(height).ok_or("截图尺寸无效")?;
    if pixels == 0 || pixels > 32_000_000 || stride < row {
        return Err("截图尺寸无效".into());
    }
    let needed = (height - 1)
        .checked_mul(stride)
        .and_then(|n| n.checked_add(row))
        .ok_or("截图数据长度无效")?;
    if data.len() < needed {
        return Err("截图数据不完整".into());
    }
    let mut out = Vec::with_capacity(pixels * 4);
    for y in 0..height {
        for bgra in data[y * stride..y * stride + row].chunks_exact(4) {
            out.extend_from_slice(&[bgra[2], bgra[1], bgra[0], 255]);
        }
    }
    Ok(out)
}
