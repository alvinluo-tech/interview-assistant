//! Exam images are bounded, compressed attachments, never base64 inside the record index.
use base64::{Engine, engine::general_purpose::STANDARD};
use image::ImageEncoder;
use serde::Serialize;
use std::{
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

fn segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
fn root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("attachments/exams"))
}
fn encode(source: &[u8]) -> Result<(Vec<u8>, &'static str), String> {
    if source.len() > 20 * 1024 * 1024 {
        return Err("单张截图超过 20MB。".into());
    }
    let reader = image::ImageReader::new(Cursor::new(source))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let (width, height) = reader.into_dimensions().map_err(|e| e.to_string())?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 40_000_000 {
        return Err("截图像素过大。".into());
    }
    let picture = image::load_from_memory(source).map_err(|e| e.to_string())?;
    if picture.color().has_alpha() {
        let rgba = picture.to_rgba8();
        if rgba.pixels().any(|pixel| pixel[3] != 255) {
            let mut png = Vec::new();
            image::codecs::png::PngEncoder::new_with_quality(
                &mut png,
                image::codecs::png::CompressionType::Best,
                image::codecs::png::FilterType::Adaptive,
            )
            .write_image(
                rgba.as_raw(),
                rgba.width(),
                rgba.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|e| e.to_string())?;
            return Ok((png, "png"));
        }
    }
    let rgb = picture.to_rgb8();
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new_with_quality(
        &mut png,
        image::codecs::png::CompressionType::Best,
        image::codecs::png::FilterType::Adaptive,
    )
    .write_image(
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        image::ExtendedColorType::Rgb8,
    )
    .map_err(|e| e.to_string())?;
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 92)
        .encode_image(&picture)
        .map_err(|e| e.to_string())?;
    if png.len() <= jpeg.len() {
        Ok((png, "png"))
    } else {
        Ok((jpeg, "jpg"))
    }
}
fn resolved(root: &Path, reference: &str) -> Result<PathBuf, String> {
    let parts: Vec<_> = reference.split('/').collect();
    if parts.len() != 3 || !segment(parts[0]) || !segment(parts[1]) {
        return Err("图片编号无效。".into());
    }
    let (stem, extension) = parts[2].rsplit_once('.').ok_or("图片编号无效。")?;
    if !segment(stem) || !["png", "jpg"].contains(&extension) {
        return Err("图片格式无效。".into());
    }
    let folder = root.canonicalize().map_err(|e| e.to_string())?;
    let path = root
        .join(reference)
        .canonicalize()
        .map_err(|_| "原图文件不存在，请检查附件目录或备份。")?;
    if !path.starts_with(folder) {
        return Err("不能读取附件目录以外的文件。".into());
    }
    Ok(path)
}

#[derive(Default)]
struct PendingFiles {
    paths: Vec<PathBuf>,
    committed: bool,
}
impl Drop for PendingFiles {
    fn drop(&mut self) {
        if !self.committed {
            for path in &self.paths {
                let _ = fs::remove_file(path);
            }
        }
    }
}

#[tauri::command]
pub async fn cmd_exam_store_images(
    app: AppHandle,
    session_id: String,
    turn_id: String,
    images: Vec<String>,
) -> Result<Vec<String>, String> {
    if !segment(&session_id) || !segment(&turn_id) || images.is_empty() || images.len() > 6 {
        return Err("截图参数无效。".into());
    }
    let base = root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let folder = base.join(&session_id).join(&turn_id);
        fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        if !folder
            .canonicalize()
            .map_err(|e| e.to_string())?
            .starts_with(base.canonicalize().map_err(|e| e.to_string())?)
        {
            return Err("截图目录位于附件根目录之外。".into());
        }
        let mut pending = PendingFiles::default();
        let mut result = Vec::new();
        for image in images {
            if image.len() > 28 * 1024 * 1024 {
                return Err("截图文件过大。".into());
            }
            let data = image
                .strip_prefix("data:image/png;base64,")
                .or_else(|| image.strip_prefix("data:image/jpeg;base64,"))
                .ok_or("仅支持 PNG/JPEG 截图。")?;
            let source = STANDARD.decode(data).map_err(|_| "截图编码无效。")?;
            let (bytes, extension) = encode(&source)?;
            if bytes.len() > 20 * 1024 * 1024 {
                return Err("压缩后的截图仍超过 20MB，请使用窗口截图。".into());
            }
            let mut nonce = [0u8; 16];
            getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
            let name = nonce.iter().map(|v| format!("{v:02x}")).collect::<String>();
            let name = format!("{name}.{extension}");
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(folder.join(&name))
                .map_err(|e| e.to_string())?;
            pending.paths.push(folder.join(&name));
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|e| e.to_string())?;
            result.push(format!("{session_id}/{turn_id}/{name}"));
        }
        pending.committed = true;
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cmd_exam_read_image(app: AppHandle, reference: String) -> Result<String, String> {
    let base = root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = resolved(&base, &reference)?;
        if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 20 * 1024 * 1024 {
            return Err("附件过大。".into());
        }
        let mime = if path.extension().is_some_and(|v| v == "png") {
            "png"
        } else {
            "jpeg"
        };
        Ok(format!(
            "data:image/{mime};base64,{}",
            STANDARD.encode(fs::read(path).map_err(|e| e.to_string())?)
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageLayout {
    data: String,
    attachments: String,
    backups: String,
    cache: String,
    logs: String,
    settings: String,
}
#[tauri::command]
pub fn cmd_storage_layout(app: AppHandle) -> Result<StorageLayout, String> {
    let local = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(StorageLayout {
        data: local.join("data").to_string_lossy().into(),
        attachments: local.join("attachments").to_string_lossy().into(),
        backups: local.join("data/backups").to_string_lossy().into(),
        cache: app
            .path()
            .app_cache_dir()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into(),
        logs: app
            .path()
            .app_log_dir()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into(),
        settings: app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into(),
    })
}

#[tauri::command]
pub fn cmd_storage_open(app: AppHandle, kind: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let layout = cmd_storage_layout(app.clone())?;
    let path = match kind.as_str() {
        "data" => layout.data,
        "attachments" => layout.attachments,
        "backups" => layout.backups,
        "cache" => layout.cache,
        "logs" => layout.logs,
        _ => return Err("未知存储目录。".into()),
    };
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::GenericImageView;
    #[test]
    fn attachments_reject_paths_and_invalid_images() {
        assert!(!segment("../escape"));
        assert!(!segment("a/b"));
        assert!(segment("exam_123-abc"));
        assert!(encode(b"not an image").is_err());
        assert!(resolved(Path::new("missing"), "../../secret").is_err());
    }
    #[test]
    fn screenshot_compression_keeps_small_text_images_at_original_dimensions() {
        let picture = image::DynamicImage::new_rgb8(1200, 800);
        let mut source = Cursor::new(Vec::new());
        picture
            .write_to(&mut source, image::ImageFormat::Png)
            .unwrap();
        let (bytes, _) = encode(&source.into_inner()).unwrap();
        assert_eq!(
            image::load_from_memory(&bytes).unwrap().dimensions(),
            (1200, 800)
        );
    }
    #[test]
    fn transparent_screenshots_preserve_alpha_instead_of_turning_black() {
        let pixels =
            image::RgbaImage::from_raw(2, 1, vec![0, 0, 0, 0, 255, 255, 255, 128]).unwrap();
        let picture = image::DynamicImage::ImageRgba8(pixels.clone());
        let mut source = Cursor::new(Vec::new());
        picture
            .write_to(&mut source, image::ImageFormat::Png)
            .unwrap();
        let (bytes, format) = encode(&source.into_inner()).unwrap();
        assert_eq!(format, "png");
        assert_eq!(image::load_from_memory(&bytes).unwrap().to_rgba8(), pixels);
    }
    #[test]
    fn an_incomplete_image_batch_removes_only_its_own_staged_files() {
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).unwrap();
        let root = std::env::temp_dir().join(format!(
            "mianxu-image-batch-{:x}",
            u64::from_le_bytes(random)
        ));
        fs::create_dir_all(&root).unwrap();
        let partial = root.join("partial.png");
        let existing = root.join("existing.png");
        fs::write(&partial, "partial").unwrap();
        fs::write(&existing, "keep").unwrap();
        drop(PendingFiles {
            paths: vec![partial.clone()],
            committed: false,
        });
        assert!(!partial.exists());
        assert_eq!(fs::read_to_string(&existing).unwrap(), "keep");
        fs::remove_dir_all(root).unwrap();
    }
}
