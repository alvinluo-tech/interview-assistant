use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tauri_plugin_store::StoreExt;
static WRITES: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Use the same plugin instance as the webviews; never overwrite unrelated settings.
pub fn save(app: &AppHandle, entries: &[(&str, Value)]) -> Result<(), String> {
    let _write = WRITES.lock().map_err(|_| "设置写入锁不可用")?;
    let store = app.store("store.json").map_err(|e| e.to_string())?;
    let previous: Vec<_> = entries
        .iter()
        .map(|(key, _)| (*key, store.get(key)))
        .collect();
    for (key, value) in entries {
        store.set(*key, value.clone());
    }
    if let Err(error) = store.save() {
        for (key, value) in previous {
            match value {
                Some(value) => store.set(key, value),
                None => {
                    store.delete(key);
                }
            }
        }
        return Err(format!("保存设置失败：{error}"));
    }
    for (key, value) in entries {
        let _ = app.emit(
            "ml-store-changed",
            serde_json::json!({"key":key, "value":value, "from":"native"}),
        );
    }
    Ok(())
}

#[tauri::command]
pub fn cmd_set_setting(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    if key.is_empty()
        || key.len() > 256
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        || key == "ai.settings.v2"
        || value.to_string().len() > 4 * 1024 * 1024
    {
        return Err("设置键或内容无效。".into());
    }
    save(&app, &[(&key, value)])
}
