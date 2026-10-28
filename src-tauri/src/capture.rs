/*
 * 截屏：GDI BitBlt 全虚拟屏 → PNG dataURL。
 * 窗口捕获策略见 protection；本应用截屏仍短暂收起浮窗，兼容演示模式与旧系统。
 */
use base64::Engine;
use tauri::{AppHandle, Manager};
fn is_blank(rgba: &[u8]) -> bool {
    if rgba.len() < 4 {
        return true;
    }
    let first = &rgba[..3];
    let step = (rgba.len() / 4 / 16000).max(1);
    let mut total = 0;
    let mut different = 0;
    for pixel in rgba.chunks_exact(4).step_by(step) {
        total += 1;
        if (0..3).any(|channel| pixel[channel].abs_diff(first[channel]) > 8) {
            different += 1;
        }
    }
    different * 1000 < total
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blank_images_are_rejected_but_dark_text_screens_are_kept() {
        assert!(is_blank(&[0u8; 4000]));
        assert!(is_blank(&[255u8; 4000]));
        let mut code = vec![12u8; 4000];
        for offset in (0..4000).step_by(80) {
            code[offset] = 180;
        }
        assert!(!is_blank(&code));
    }
}

#[tauri::command]
pub fn cmd_capture_screen(
    app: AppHandle,
    compatibility_mode: Option<bool>,
    capture_mode: Option<String>,
    _protected_on_top: Option<bool>,
) -> Result<String, String> {
    // 短暂收起以避免在演示模式/系统不支持时截到自身浮窗。
    let overlay = app.get_webview_window("overlay");
    let was_overlay_visible = overlay
        .as_ref()
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);
    if was_overlay_visible {
        if let Some(w) = &overlay {
            let _ = w.hide();
        }
        std::thread::sleep(std::time::Duration::from_millis(350));
    }
    let result = match capture_mode.as_deref() {
        Some("window") => capture_image(true),
        None | Some("screen") => {
            let prefer_window = compatibility_mode.unwrap_or(false);
            capture_image(prefer_window).or_else(|_| capture_image(!prefer_window))
        }
        _ => Err("截图范围无效，请选择屏幕或前台窗口。".into()),
    };
    if was_overlay_visible {
        if let Some(w) = &overlay {
            let _ = w.show();
        }
    }
    let png = result?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(png);
    Ok(format!("data:image/png;base64,{b64}"))
}

#[cfg(windows)]
fn capture_image(window_mode: bool) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{
        BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, CreateCompatibleBitmap,
        CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetDIBits, HBITMAP, HDC,
        HGDIOBJ, ReleaseDC, SRCCOPY, SelectObject,
    };
    use windows::Win32::Storage::Xps::{PRINT_WINDOW_FLAGS, PrintWindow};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetSystemMetrics, GetWindowRect, GetWindowThreadProcessId,
        IsHungAppWindow, PW_RENDERFULLCONTENT, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
        SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    };
    struct Surface {
        screen: HDC,
        mem: HDC,
        bitmap: HBITMAP,
        old: HGDIOBJ,
    }
    impl Drop for Surface {
        fn drop(&mut self) {
            unsafe {
                if !self.old.is_invalid() && !self.mem.is_invalid() {
                    SelectObject(self.mem, self.old);
                }
                if !self.bitmap.is_invalid() {
                    let _ = DeleteObject(self.bitmap.into());
                }
                if !self.mem.is_invalid() {
                    let _ = DeleteDC(self.mem);
                }
                if !self.screen.is_invalid() {
                    ReleaseDC(None, self.screen);
                }
            }
        }
    }

    unsafe {
        let foreground = GetForegroundWindow();
        let (sx, sy, w, h) = if window_mode {
            let mut pid = 0;
            GetWindowThreadProcessId(foreground, Some(&mut pid));
            if foreground.is_invalid()
                || pid == std::process::id()
                || IsHungAppWindow(foreground).as_bool()
            {
                return Err("请将题目窗口切到前台后重试。".into());
            }
            let mut rect = RECT::default();
            GetWindowRect(foreground, &mut rect).map_err(|e| e.to_string())?;
            (0, 0, rect.right - rect.left, rect.bottom - rect.top)
        } else {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        };
        if w <= 0 || h <= 0 || (w as i64) * (h as i64) > 32_000_000 {
            return Err("capture failed: invalid screen metrics".into());
        }

        let hdc_screen = GetDC(None);
        if hdc_screen.is_invalid() {
            return Err("capture failed: GetDC".into());
        }
        let hdc_mem = CreateCompatibleDC(Some(hdc_screen));
        let hbitmap = CreateCompatibleBitmap(hdc_screen, w, h);
        let mut surface = Surface {
            screen: hdc_screen,
            mem: hdc_mem,
            bitmap: hbitmap,
            old: HGDIOBJ::default(),
        };
        if hdc_mem.is_invalid() || hbitmap.is_invalid() {
            return Err("截图缓冲区创建失败。".into());
        }
        surface.old = SelectObject(hdc_mem, hbitmap.into());

        let blit = if window_mode {
            PrintWindow(
                foreground,
                hdc_mem,
                PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT),
            )
            .ok()
        } else {
            BitBlt(
                hdc_mem,
                0,
                0,
                w,
                h,
                Some(hdc_screen),
                sx,
                sy,
                SRCCOPY | CAPTUREBLT,
            )
        };
        let mut ok = blit.is_ok();
        if ok {
            let mut bmi = BITMAPINFO::default();
            bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            bmi.bmiHeader.biWidth = w;
            // 负高度 = top-down
            bmi.bmiHeader.biHeight = -h;
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = 0; // BI_RGB
            let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
            SelectObject(hdc_mem, surface.old);
            surface.old = HGDIOBJ::default();
            let lines = GetDIBits(
                hdc_mem,
                hbitmap,
                0,
                h as u32,
                Some(buf.as_mut_ptr() as *mut _),
                &mut bmi,
                DIB_RGB_COLORS,
            );
            ok = lines == h;
            if ok {
                // BGRA → RGBA
                for px in buf.chunks_exact_mut(4) {
                    px.swap(0, 2);
                    px[3] = 255;
                }
                if is_blank(&buf) {
                    return Err("截图为空白或黑屏。请把题目移到前台，尝试切换截图兼容模式。".into());
                }
                let img: image::RgbaImage = image::ImageBuffer::from_raw(w as u32, h as u32, buf)
                    .ok_or("capture failed: bad buffer")?;
                // 最长边压到 1600，控制送 AI 的体积
                let (iw, ih) = (img.width(), img.height());
                let img = if iw.max(ih) > 1600 {
                    let scale = 1600.0 / iw.max(ih) as f32;
                    let nw = (iw as f32 * scale) as u32;
                    let nh = (ih as f32 * scale) as u32;
                    image::imageops::resize(&img, nw, nh, image::imageops::FilterType::Triangle)
                } else {
                    img
                };
                let mut png: Vec<u8> = Vec::new();
                image::DynamicImage::ImageRgba8(img)
                    .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
                    .map_err(|e| format!("encode failed: {e}"))?;
                return Ok(png);
            }
        }
        Err("capture failed: BitBlt/GetDIBits".into())
    }
}

#[cfg(not(windows))]
fn capture_image(_window_mode: bool) -> Result<Vec<u8>, String> {
    Err("screen capture is only implemented on Windows in this build".into())
}

// ---------- 权限守卫（Windows 无 per-app 屏幕录制权限，直接成功） ----------

#[tauri::command]
pub fn cmd_check_screen_capture_permission() -> bool {
    true
}

#[tauri::command]
pub fn cmd_request_screen_capture_permission() -> bool {
    true
}

#[tauri::command]
pub fn cmd_open_screen_recording_settings() -> bool {
    true
}
