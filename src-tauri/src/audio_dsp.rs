//! Format conversion and time-aligned mixing shared by the WASAPI worker and regression tests.
#[cfg(any(windows, test))]
use std::collections::VecDeque;

#[cfg(any(windows, test))]
pub const CHUNK_SAMPLES: usize = 1600; // 100 ms of mono PCM16 at 16 kHz.

#[cfg(any(windows, test))]
#[derive(Clone, Copy)]
pub enum Encoding {
    Pcm,
    Float,
}

#[cfg(any(windows, test))]
pub struct AudioFormat {
    pub rate: u32,
    channels: usize,
    bytes_per_sample: usize,
    block_align: usize,
    encoding: Encoding,
}

#[cfg(any(windows, test))]
impl AudioFormat {
    pub fn new(
        rate: u32,
        channels: u16,
        bits: u16,
        block_align: u16,
        encoding: Encoding,
    ) -> Result<Self, String> {
        let supported = match encoding {
            Encoding::Pcm => matches!(bits, 8 | 16 | 24 | 32),
            Encoding::Float => matches!(bits, 32 | 64),
        };
        let bytes_per_sample = usize::from(bits / 8);
        if !supported
            || !(8000..=384000).contains(&rate)
            || channels == 0
            || usize::from(block_align) != usize::from(channels) * bytes_per_sample
        {
            return Err("不支持的系统音频格式，请将播放设备设为标准 PCM 格式后重试".into());
        }
        Ok(Self {
            rate,
            channels: channels.into(),
            bytes_per_sample,
            block_align: block_align.into(),
            encoding,
        })
    }

    pub fn byte_count(&self, frames: usize) -> Result<usize, String> {
        if frames > self.rate as usize * 2 {
            return Err("系统音频数据包过大".into());
        }
        Ok(frames * self.block_align)
    }

    pub fn decode(
        &self,
        data: Option<&[u8]>,
        frames: usize,
        silent: bool,
    ) -> Result<Vec<f32>, String> {
        let count = self.byte_count(frames)?;
        // WASAPI may supply an unspecified or null pointer for a SILENT packet.
        if silent {
            return Ok(vec![0.0; frames]);
        }
        let data = data
            .filter(|bytes| bytes.len() >= count)
            .ok_or("系统音频缓冲区为空或不完整")?;
        Ok(data[..count]
            .chunks_exact(self.block_align)
            .map(|frame| {
                frame
                    .chunks_exact(self.bytes_per_sample)
                    .map(|sample| {
                        let value = match (self.encoding, self.bytes_per_sample) {
                            (Encoding::Pcm, 1) => (f32::from(sample[0]) - 128.0) / 128.0,
                            (Encoding::Pcm, 2) => {
                                f32::from(i16::from_le_bytes(sample.try_into().unwrap())) / 32768.0
                            }
                            (Encoding::Pcm, 3) => {
                                let signed =
                                    i32::from_le_bytes([0, sample[0], sample[1], sample[2]]);
                                signed as f32 / 2147483648.0
                            }
                            (Encoding::Pcm, 4) => {
                                i32::from_le_bytes(sample.try_into().unwrap()) as f32 / 2147483648.0
                            }
                            (Encoding::Float, 4) => f32::from_le_bytes(sample.try_into().unwrap()),
                            (Encoding::Float, 8) => {
                                f64::from_le_bytes(sample.try_into().unwrap()) as f32
                            }
                            _ => unreachable!(),
                        };
                        if value.is_finite() {
                            value.clamp(-1.0, 1.0)
                        } else {
                            0.0
                        }
                    })
                    .sum::<f32>()
                    / self.channels as f32
            })
            .collect())
    }
}

/// One output sample per instant, regardless of the number of playback devices.
#[cfg(any(windows, test))]
pub fn mix_chunk(buffers: &mut [VecDeque<i16>]) -> Vec<i16> {
    (0..CHUNK_SAMPLES)
        .map(|_| {
            buffers
                .iter_mut()
                .map(|buffer| i64::from(buffer.pop_front().unwrap_or(0)))
                .sum::<i64>()
                .clamp(i64::from(i16::MIN), i64::from(i16::MAX)) as i16
        })
        .collect()
}

/// Same normalized average-amplitude scale as the microphone pipeline.
pub fn input_volume(pcm: &[i16]) -> f64 {
    if pcm.is_empty() {
        return 0.0;
    }
    pcm.iter()
        .map(|sample| f64::from(*sample).abs() / 32768.0)
        .sum::<f64>()
        / pcm.len() as f64
        * 800.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm_formats_decode_without_being_misread_as_float() {
        for (bits, data) in [
            (16, 16384i16.to_le_bytes().to_vec()),
            (24, vec![0, 0, 64]),
            (32, 1073741824i32.to_le_bytes().to_vec()),
        ] {
            let format = AudioFormat::new(48000, 1, bits, bits / 8, Encoding::Pcm).unwrap();
            assert_eq!(format.decode(Some(&data), 1, false).unwrap(), vec![0.5]);
        }
        let format = AudioFormat::new(48000, 2, 32, 8, Encoding::Float).unwrap();
        let data = [0.25f32.to_le_bytes(), 0.75f32.to_le_bytes()].concat();
        assert_eq!(format.decode(Some(&data), 1, false).unwrap(), vec![0.5]);
    }

    #[test]
    fn silent_packets_are_zero_even_with_stale_or_missing_data() {
        let format = AudioFormat::new(48000, 2, 32, 8, Encoding::Float).unwrap();
        assert_eq!(
            format.decode(Some(&[255; 16]), 2, true).unwrap(),
            vec![0.0; 2]
        );
        assert_eq!(format.decode(None, 2, true).unwrap(), vec![0.0; 2]);
        assert!(format.decode(None, 2, false).is_err());
        assert!(format.decode(Some(&[0; 4]), 2, false).is_err());
        assert!(AudioFormat::new(0, 2, 32, 8, Encoding::Float).is_err());
    }

    #[test]
    fn parallel_devices_mix_without_repeating_or_stretching_the_timeline() {
        let mut buffers = vec![
            VecDeque::from(vec![1000; CHUNK_SAMPLES]),
            VecDeque::from(vec![2000; CHUNK_SAMPLES]),
        ];
        let output = mix_chunk(&mut buffers);
        assert_eq!(output, vec![3000; CHUNK_SAMPLES]);
        assert!(buffers.iter().all(VecDeque::is_empty));
        assert_eq!(mix_chunk(&mut buffers), vec![0; CHUNK_SAMPLES]);
        buffers[0] = VecDeque::from(vec![30000; CHUNK_SAMPLES]);
        buffers[1] = VecDeque::from(vec![30000; CHUNK_SAMPLES]);
        assert_eq!(mix_chunk(&mut buffers), vec![32767; CHUNK_SAMPLES]);
    }

    #[test]
    fn volume_has_microphone_scale_and_handles_negative_full_scale() {
        assert_eq!(input_volume(&[0; 1600]), 0.0);
        assert!((input_volume(&[3277; 1600]) - 80.0).abs() < 0.1);
        assert_eq!(input_volume(&[i16::MIN]), 800.0);
    }
}
