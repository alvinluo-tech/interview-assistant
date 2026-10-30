use serde_json::{Map, Value, json};
use std::{collections::BTreeSet, fs, io::Write, path::Path, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager};

const KEYS: &[&str] = &[
    "interviewSessions",
    "examSessions",
    "resumes",
    "goals",
    "materials",
    "localUser",
    "interviewPreference",
    "questionBanks",
    "feedback",
];
const MAX_BYTES: u64 = 64 * 1024 * 1024;
#[derive(Default)]
pub struct DataState(Mutex<Option<Map<String, Value>>>);

// Three-way merge: preserve edits from other windows, reject conflicting edits.
fn merge_value(base: &Value, current: &Value, next: &Value) -> Result<Value, String> {
    if base == next || current == next {
        return Ok(current.clone());
    }
    if base == current {
        return Ok(next.clone());
    }
    if let (Some(b), Some(c), Some(n)) = (base.as_object(), current.as_object(), next.as_object()) {
        let keys: BTreeSet<_> = b.keys().chain(c.keys()).chain(n.keys()).collect();
        let mut merged = Map::new();
        for key in keys {
            let value = merge_optional(b.get(key), c.get(key), n.get(key))?;
            if let Some(value) = value {
                merged.insert(key.clone(), value);
            }
        }
        return Ok(Value::Object(merged));
    }
    if let (Some(b), Some(c), Some(n)) = (base.as_array(), current.as_array(), next.as_array()) {
        let valid = |rows: &[Value]| {
            let mut ids = BTreeSet::new();
            rows.iter().all(|row| {
                row["id"]
                    .as_str()
                    .is_some_and(|id| !id.is_empty() && ids.insert(id))
            })
        };
        if valid(b) && valid(c) && valid(n) {
            let ids: BTreeSet<_> = b
                .iter()
                .chain(c)
                .chain(n)
                .map(|row| row["id"].as_str().unwrap())
                .collect();
            let mut merged = Vec::new();
            for id in ids {
                let find = |rows: &[Value]| rows.iter().find(|row| row["id"] == id).cloned();
                if let Some(value) =
                    merge_optional(find(b).as_ref(), find(c).as_ref(), find(n).as_ref())?
                {
                    merged.push(value);
                }
            }
            // Keep the proposed display order, followed by records added in other windows.
            merged.sort_by_key(|row| {
                n.iter().position(|item| item["id"] == row["id"]).unwrap_or(
                    n.len()
                        + c.iter()
                            .position(|item| item["id"] == row["id"])
                            .unwrap_or(c.len()),
                )
            });
            return Ok(Value::Array(merged));
        }
    }
    Err("其他窗口已修改同一数据，请刷新后重试；本次更改尚未保存。".into())
}
fn merge_optional(
    base: Option<&Value>,
    current: Option<&Value>,
    next: Option<&Value>,
) -> Result<Option<Value>, String> {
    if base == next || current == next {
        return Ok(current.cloned());
    }
    if base == current {
        return Ok(next.cloned());
    }
    match (base, current, next) {
        (Some(b), Some(c), Some(n)) => merge_value(b, c, n).map(Some),
        _ => Err("数据已在其他窗口修改或删除，请刷新后重试。".into()),
    }
}
fn read_document(path: &Path) -> Result<Map<String, Value>, String> {
    if !path.exists() {
        return Ok(Map::new());
    }
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > MAX_BYTES {
        return Err("本地数据超过 64MB，请先备份整理。".into());
    }
    let bytes = fs::read(path).map_err(|e| format!("读取本地数据失败：{e}"))?;
    serde_json::from_slice::<Value>(&bytes)
        .map_err(|_| "本地数据损坏，已阻止覆盖；可在设置中恢复手动备份。".to_string())?
        .as_object()
        .cloned()
        .ok_or("本地数据格式无效，已阻止覆盖。".into())
}
fn atomic_write(path: &Path, value: &Map<String, Value>) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("本地数据超过 64MB。".into());
    }
    let temporary = path.with_extension("tmp");
    let result = (|| {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(temporary);
        return Err(format!("数据保存失败，请检查磁盘和文件权限：{error}"));
    }
    Ok(())
}
fn snapshot(data: &Map<String, Value>) -> Value {
    json!({"revision":data.get("__revision").and_then(Value::as_u64).unwrap_or(0), "data":data})
}
fn migrate_folder(legacy: &Path, path: &Path) -> Result<(), String> {
    fs::create_dir_all(path.join("backups")).map_err(|e| e.to_string())?;
    if !path.join("data.json").exists() && legacy.join("data.json").exists() {
        let document = read_document(&legacy.join("data.json"))?;
        for name in ["data.previous.json", "data.manual-backup.json"] {
            if legacy.join(name).exists() && !path.join("backups").join(name).exists() {
                match read_document(&legacy.join(name)) {
                    Ok(backup) => atomic_write(&path.join("backups").join(name), &backup)?,
                    Err(_) => log::warn!("[storage] legacy backup {name} is invalid; original file preserved"),
                }
            }
        }
        atomic_write(&path.join("data.json"), &document)?;
    }
    Ok(())
}
fn folder(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    static MIGRATION: Mutex<()> = Mutex::new(());
    let _lock = MIGRATION.lock().map_err(|_| "存储迁移锁异常")?;
    let path = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("data");
    let legacy = app.path().app_data_dir().map_err(|e| e.to_string())?;
    migrate_folder(&legacy, &path)?;
    Ok(path)
}

#[cfg(test)]
mod migration_tests {
    use super::*;
    fn temporary() -> std::path::PathBuf {
        let mut random = [0u8; 8]; getrandom::fill(&mut random).unwrap();
        std::env::temp_dir().join(format!("mianxu-storage-{:x}", u64::from_le_bytes(random)))
    }
    #[test]
    fn migration_preserves_legacy_data_and_never_overwrites_newer_records() {
        let root = temporary(); let legacy = root.join("legacy"); let local = root.join("local");
        fs::create_dir_all(&legacy).unwrap();
        let document = serde_json::from_value(json!({"examSessions":[{"id":"old"}]})).unwrap();
        atomic_write(&legacy.join("data.json"), &document).unwrap();
        atomic_write(&legacy.join("data.manual-backup.json"), &document).unwrap();
        migrate_folder(&legacy, &local).unwrap();
        assert_eq!(read_document(&local.join("data.json")).unwrap(), document);
        assert!(legacy.join("data.json").is_file());
        assert!(local.join("backups/data.manual-backup.json").is_file());
        let new = serde_json::from_value(json!({"examSessions":[{"id":"new"}]})).unwrap();
        atomic_write(&local.join("data.json"), &new).unwrap();
        migrate_folder(&legacy, &local).unwrap();
        assert_eq!(read_document(&local.join("data.json")).unwrap(), new);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn corrupt_legacy_data_is_not_marked_as_migrated() {
        let root = temporary(); let legacy = root.join("legacy"); let local = root.join("local");
        fs::create_dir_all(&legacy).unwrap(); fs::write(legacy.join("data.json"), "broken").unwrap();
        assert!(migrate_folder(&legacy, &local).is_err()); assert!(!local.join("data.json").exists());
        assert_eq!(fs::read_to_string(legacy.join("data.json")).unwrap(), "broken");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn a_corrupt_old_backup_does_not_block_migration_of_valid_records() {
        let root = temporary(); let legacy = root.join("legacy"); let local = root.join("local");
        fs::create_dir_all(&legacy).unwrap();
        let data = serde_json::from_value(json!({"examSessions":[{"id":"valid"}]})).unwrap();
        atomic_write(&legacy.join("data.json"), &data).unwrap();
        fs::write(legacy.join("data.manual-backup.json"), "broken backup").unwrap();
        migrate_folder(&legacy, &local).unwrap();
        assert_eq!(read_document(&local.join("data.json")).unwrap(), data);
        assert_eq!(fs::read_to_string(legacy.join("data.manual-backup.json")).unwrap(), "broken backup");
        fs::remove_dir_all(root).unwrap();
    }
}
#[tauri::command]
pub fn cmd_data_read(app: AppHandle, state: tauri::State<DataState>) -> Result<Value, String> {
    let mut state = state.0.lock().map_err(|_| "数据锁异常")?;
    if state.is_none() {
        *state = Some(read_document(&folder(&app)?.join("data.json"))?);
    }
    Ok(snapshot(state.as_ref().unwrap()))
}
#[tauri::command]
pub fn cmd_data_commit(
    app: AppHandle,
    state: tauri::State<DataState>,
    key: String,
    expected: Value,
    value: Value,
) -> Result<Value, String> {
    if !KEYS.contains(&key.as_str()) {
        return Err("未知数据集合".into());
    }
    if value.to_string().len() as u64 > MAX_BYTES || expected.to_string().len() as u64 > MAX_BYTES {
        return Err("数据集合过大。".into());
    }
    if !matches!(key.as_str(), "localUser" | "interviewPreference") {
        let rows = value.as_array().ok_or("数据集合必须是记录列表。")?;
        let mut ids = BTreeSet::new();
        if rows.len() > 100000
            || !rows.iter().all(|row| {
                row["id"]
                    .as_str()
                    .is_some_and(|id| !id.is_empty() && id.len() < 1024 && ids.insert(id))
            })
        {
            return Err("记录 ID 无效或重复。".into());
        }
    }
    let mut state = state.0.lock().map_err(|_| "数据锁异常")?;
    let dir = folder(&app)?;
    if state.is_none() {
        *state = Some(read_document(&dir.join("data.json"))?);
    }
    let current = state.as_ref().unwrap();
    let empty = if value.is_array() {
        json!([])
    } else {
        Value::Null
    };
    let base = if expected.is_null() {
        &empty
    } else {
        &expected
    };
    let updated = merge_value(base, current.get(&key).unwrap_or(&empty), &value)?;
    let mut next = current.clone();
    next.insert(key, updated);
    next.insert(
        "__revision".into(),
        (current
            .get("__revision")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            + 1)
        .into(),
    );
    atomic_write(&dir.join("backups/data.previous.json"), current)?;
    atomic_write(&dir.join("data.json"), &next)?;
    let result = snapshot(&next);
    *state = Some(next);
    let _ = app.emit("ml-data-revision", &result["revision"]);
    Ok(result)
}
#[tauri::command]
pub fn cmd_data_backup(
    app: AppHandle,
    state: tauri::State<DataState>,
    restore: bool,
) -> Result<Value, String> {
    let mut state = state.0.lock().map_err(|_| "数据锁异常")?;
    let dir = folder(&app)?;
    let path = dir.join("backups/data.manual-backup.json");
    if restore {
        if !path.is_file() {
            return Err("还没有手动备份。".into());
        }
        let mut restored = read_document(&path)?;
        let current = match state.as_ref() {
            Some(value) => value.clone(),
            None => read_document(&dir.join("data.json")).unwrap_or_default(),
        };
        restored.insert(
            "__revision".into(),
            (current
                .get("__revision")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                + 1)
            .into(),
        );
        // Keep the pre-restore file, including a corrupt file, for manual recovery.
        if dir.join("data.json").exists() {
            fs::copy(dir.join("data.json"), dir.join("data.before-restore.json"))
                .map_err(|e| e.to_string())?;
        }
        atomic_write(&dir.join("data.json"), &restored)?;
        *state = Some(restored);
        let _ = app.emit("ml-data-revision", ());
    } else {
        if state.is_none() {
            *state = Some(read_document(&dir.join("data.json"))?);
        }
        atomic_write(&path, state.as_ref().unwrap())?;
    }
    Ok(snapshot(state.as_ref().unwrap()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn stale_windows_merge_separate_records_and_separate_fields() {
        let base = json!([{ "id":"a", "title":"old", "content":"body" }]);
        let current =
            json!([{ "id":"b", "title":"new" }, { "id":"a", "title":"changed", "content":"body" }]);
        let next = json!([{ "id":"a", "title":"old", "content":"edited body" }, { "id":"c", "title":"another" }]);
        let merged = merge_value(&base, &current, &next).unwrap();
        let rows = merged.as_array().unwrap();
        assert_eq!(rows.len(), 3);
        let a = rows.iter().find(|row| row["id"] == "a").unwrap();
        assert_eq!(a["title"], "changed");
        assert_eq!(a["content"], "edited body");
    }
    #[test]
    fn overlapping_changes_and_deleting_an_edited_record_are_rejected() {
        assert!(
            merge_value(
                &json!({"text":"old"}),
                &json!({"text":"one"}),
                &json!({"text":"two"})
            )
            .is_err()
        );
        assert!(
            merge_value(
                &json!([{"id":"a","text":"old"}]),
                &json!([{"id":"a","text":"new"}]),
                &json!([])
            )
            .is_err()
        );
        assert_eq!(
            merge_value(
                &json!([{"id":"a"}]),
                &json!([{"id":"a"},{"id":"b"}]),
                &json!([])
            )
            .unwrap(),
            json!([{"id":"b"}])
        );
    }
}

#[cfg(test)]
mod audit_tests {
    use super::*;
    #[test]
    fn job_progress_is_an_accepted_persistent_collection() {
        assert!(KEYS.contains(&"jobProgress"));
    }
}
