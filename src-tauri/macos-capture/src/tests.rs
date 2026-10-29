use super::media::{AudioFormat, AudioPlane, PcmChunks, SampleKind, bgra_to_rgba, decode_audio};

#[test]
fn planar_stereo_float_is_mixed_without_changing_duration() {
    let left: Vec<u8> = [0.5f32, -0.5, 1.0, f32::NAN]
        .into_iter()
        .flat_map(f32::to_le_bytes)
        .collect();
    let right: Vec<u8> = [0.25f32, -0.25, -1.0, 0.0]
        .into_iter()
        .flat_map(f32::to_le_bytes)
        .collect();
    let format = AudioFormat {
        rate: 48000,
        channels: 2,
        kind: SampleKind::Float32,
        big_endian: false,
        planar: true,
        bytes_per_frame: 4,
    };
    let mono = decode_audio(
        format,
        &[
            AudioPlane {
                channels: 1,
                data: &left,
            },
            AudioPlane {
                channels: 1,
                data: &right,
            },
        ],
        4,
    )
    .unwrap();
    assert_eq!(mono, [0.375, -0.375, 0.0, 0.0]);
}

#[test]
fn interleaved_big_endian_pcm16_and_truncated_packets() {
    let bytes: Vec<u8> = [16384i16, 0, -16384, 0]
        .into_iter()
        .flat_map(i16::to_be_bytes)
        .collect();
    let format = AudioFormat {
        rate: 16000,
        channels: 2,
        kind: SampleKind::Signed16,
        big_endian: true,
        planar: false,
        bytes_per_frame: 4,
    };
    assert_eq!(
        decode_audio(
            format,
            &[AudioPlane {
                channels: 2,
                data: &bytes
            }],
            2
        )
        .unwrap(),
        [0.25, -0.25]
    );
    assert!(
        decode_audio(
            format,
            &[AudioPlane {
                channels: 2,
                data: &bytes[..5]
            }],
            2
        )
        .is_err()
    );
    assert!(
        decode_audio(
            format,
            &[AudioPlane {
                channels: 1,
                data: &bytes
            }],
            2
        )
        .is_err()
    );
}

#[test]
fn resampled_chunks_are_exactly_100ms_and_keep_one_second() {
    for rate in [16000, 24000, 44100, 48000] {
        let mut chunks = PcmChunks::new(rate).unwrap();
        let mut output = Vec::new();
        for packet in vec![0.25f32; rate as usize].chunks(441) {
            output.extend(chunks.push(packet));
        }
        assert_eq!(output.len(), 10, "{rate}Hz");
        assert!(output.iter().all(|p| p.len() == 1600));
        assert!(output.iter().flatten().all(|s| *s == 8192));
    }
    assert!(PcmChunks::new(0).is_err());
}

#[test]
fn bgra_rows_skip_padding_and_reject_invalid_sizes() {
    let padded = [1, 2, 3, 255, 90, 90, 90, 90, 4, 5, 6, 255];
    assert_eq!(
        bgra_to_rgba(&padded, 1, 2, 8).unwrap(),
        [3, 2, 1, 255, 6, 5, 4, 255]
    );
    assert!(bgra_to_rgba(&padded[..10], 1, 2, 8).is_err());
    assert!(bgra_to_rgba(&padded, 2, 1, 4).is_err());
    assert!(bgra_to_rgba(&[], u32::MAX as usize, u32::MAX as usize, usize::MAX).is_err());
    assert!(bgra_to_rgba(&[], 0, 1, 4).is_err());
}
