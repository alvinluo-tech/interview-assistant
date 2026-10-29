pub struct WindowCandidate {
    pub id: u32, pub pid: u32, pub layer: i32, pub visible: bool, pub width: f64, pub height: f64,
}

pub fn choose_window(ordered_ids: &[u32], candidates: &[WindowCandidate], own_pid: u32) -> Result<u32, String> {
    ordered_ids.iter().copied().find(|id| candidates.iter().any(|w|
        w.id == *id && w.pid != own_pid && w.pid != 0 && w.layer == 0 && w.visible && w.width > 1.0 && w.height > 1.0
    )).ok_or_else(|| "未找到可截图的前台窗口，请将题目窗口切到前台后重试。".into())
}

/// Tao reports the global Mac cursor at the primary display scale, while its
/// window positions use the window's current display scale. Normalize both to
/// the same top-left coordinate space used by our DOM zones and phone cursor.
pub fn cursor_in_window_space(cursor: (f64, f64), primary_scale: f64, window_scale: f64) -> Result<(i32, i32), String> {
    if !cursor.0.is_finite() || !cursor.1.is_finite() || !primary_scale.is_finite() || !window_scale.is_finite() || primary_scale <= 0.0 || window_scale <= 0.0 {
        return Err("光标坐标或显示器缩放无效".into());
    }
    Ok(((cursor.0 / primary_scale * window_scale).round() as i32, (cursor.1 / primary_scale * window_scale).round() as i32))
}
