//! Level conditioning shared by enrollment and speaker identification.
//! Input gain is not a measure of speaker identity. Bound the correction so
//! digital silence and very weak noise cannot be amplified without limit.
pub fn prepare_samples(pcm: &[i16]) -> Result<Vec<f32>, String> {
    if pcm.is_empty() {
        return Err("没有收到麦克风音频，请检查输入设备后重新试音。".into());
    }
    let clipped = pcm.iter().filter(|x| x.unsigned_abs() > 32700).count();
    if clipped * 20 > pcm.len() {
        return Err("录音有严重削波，请降低麦克风输入音量后重新试音。".into());
    }
    let mean = pcm.iter().map(|&x| f64::from(x)).sum::<f64>() / pcm.len() as f64;
    let rms = (pcm
        .iter()
        .map(|&x| (f64::from(x) - mean).powi(2))
        .sum::<f64>()
        / pcm.len() as f64)
        .sqrt();
    // At most 30 dB of gain; leave already loud recordings at their input level.
    let gain = (1310.72 / rms.max(1.0)).clamp(1.0, 32.0);
    let active = pcm
        .iter()
        .filter(|&&x| ((f64::from(x) - mean) * gain).abs() > 500.0)
        .count();
    if rms < 8.0 || active * 20 < pcm.len() {
        return Err(
            "录音中的声音仍过弱，请确认所选麦克风能收到说话声，再连续说话重新试音。".into(),
        );
    }
    let peak = pcm
        .iter()
        .map(|&x| (f64::from(x) - mean).abs())
        .fold(0.0, f64::max);
    let gain = gain.min(32700.0 / peak.max(1.0));
    Ok(pcm
        .iter()
        .map(|&x| (((f64::from(x) - mean) * gain) / 32768.0) as f32)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn voice(amplitude: f64) -> Vec<i16> {
        (0..16000 * 6)
            .map(|i| {
                let envelope = 0.3 + 0.7 * (i as f64 / 1900.0).sin().abs();
                (amplitude * envelope * (i as f64 * 0.07).sin()) as i16
            })
            .collect()
    }
    #[test]
    fn quiet_voice_is_not_confused_with_silence() {
        let quiet = voice(300.0);
        assert!(quiet.iter().all(|x| x.unsigned_abs() < 500));
        let a = prepare_samples(&quiet).unwrap();
        let b = prepare_samples(&voice(9600.0)).unwrap();
        let correlation = a.iter().zip(&b).map(|(a, b)| f64::from(a * b)).sum::<f64>()
            / (a.iter().map(|x| f64::from(x * x)).sum::<f64>()
                * b.iter().map(|x| f64::from(x * x)).sum::<f64>())
            .sqrt();
        assert!(correlation > 0.999);
        assert!(a.iter().all(|x| x.abs() <= 1.0));
    }
    #[test]
    fn silence_dc_tiny_noise_and_clipping_still_fail() {
        assert!(prepare_samples(&[]).is_err());
        assert!(prepare_samples(&vec![0; 96000]).is_err());
        assert!(prepare_samples(&vec![1000; 96000]).is_err());
        assert!(prepare_samples(&voice(5.0)).is_err());
        assert!(
            prepare_samples(&vec![i16::MIN; 96000])
                .unwrap_err()
                .contains("削波")
        );
    }
}
