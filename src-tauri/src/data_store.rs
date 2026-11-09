use serde_json::{Map, Value, json};
use std::{collections::BTreeSet, fs, io::Write, path::Path, sync::Mutex, time::{Duration, Instant}};
use tauri::{AppHandle, Emitter, Manager};

/// 面试中每 2 秒就提交一次，整份文档重写两遍会放大成 MB/s 的写入；
/// 回滚点最多每 30 秒刷新一次，data.json 本身仍是每次原子写。
static LAST_PREVIOUS_BACKUP: Mutex<Option<Instant>> = Mutex::new(None);
fn write_previous_backup(dir: &Path, current: &Map<String, Value>) {
    let now = Instant::now();
    let Ok(mut last) = LAST_PREVIOUS_BACKUP.lock() else { return; };
    let due = last.as_ref().map(|at| now.duration_since(*at) >= Duration::from_secs(30)).unwrap_or(true);
    if !due {
        return;
    }
    if atomic_write(&dir.join("backups/data.previous.json"), current).is_ok() {
        *last = Some(now);
    }
}
/// 只保留最近 N 份恢复前快照，避免备份目录无限增长。
fn prune_restore_snapshots(dir: &Path, keep: usize) {
    let Ok(entries) = fs::read_dir(dir) else { return; };
    let mut files: Vec<_> = entries
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("data.before-restore-"))
        .map(|entry| entry.path())
        .collect();
    files.sort();
    while files.len() > keep {
        let path = files.remove(0);
        if let Err(error) = fs::remove_file(&path) {
            log::warn!("[data_store] 无法删除旧快照 {}：{error}", path.display());
        }
    }
}

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
    "jobProgress",
    "freeChats",
];
const MAX_BYTES: u64 = 64 * 1024 * 1024;
#[derive(Default)]
pub struct DataState(Mutex<Option<Map<String, Value>>>);

const SCHEMA_VERSION: u64 = 1;
fn identified_rows(value: &Value) -> Result<(), String> {
    let rows = value.as_array().ok_or("数据集合必须是记录列表。")?;
    let mut ids = BTreeSet::new();
    if rows.len() > 100000
        || !rows.iter().all(|row| {
            row.is_object()
                && row["id"]
                    .as_str()
                    .is_some_and(|id| !id.is_empty() && id.len() < 1024 && ids.insert(id))
        })
    {
        return Err("记录 ID 无效或重复。".into());
    }
    Ok(())
}
fn strings(row: &Value, fields: &[&str]) -> Result<(), String> {
    for field in fields {
        if row.get(*field).is_some_and(|value| !value.is_string()) {
            return Err(format!("字段 {field} 必须是文字；原数据已保留。"));
        }
    }
    Ok(())
}
fn list_field<'a>(row: &'a mut Value, name: &str) -> Result<&'a mut Vec<Value>, String> {
    let object = row.as_object_mut().ok_or("记录必须是对象。")?;
    // Version 0 records may omit collections; explicit wrong types are never erased.
    object
        .entry(name)
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or_else(|| format!("字段 {name} 必须是列表；原数据已保留。"))
}
fn normalize_collection(key: &str, value: &mut Value) -> Result<(), String> {
    if matches!(key, "localUser" | "interviewPreference" | "jobProgress") {
        return if value.is_object() {
            Ok(())
        } else {
            Err("数据集合必须是对象。".into())
        };
    }
    identified_rows(value)?;
    for row in value.as_array_mut().unwrap() {
        strings(row, &["title", "name", "content", "summary", "description"])?;
        if matches!(key, "interviewSessions" | "examSessions")
            && row
                .get("status")
                .is_some_and(|v| !matches!(v.as_str(), Some("ACTIVE" | "COMPLETED")))
        {
            return Err("会话状态无效。".into());
        }
        if key == "interviewSessions"
            && row
                .get("type")
                .is_some_and(|v| !matches!(v.as_str(), Some("INTERVIEW" | "MOCK_INTERVIEW")))
        {
            return Err("面试类型无效。".into());
        }
        if row
            .get("metadata")
            .is_some_and(|value| !value.is_object() && !value.is_null())
        {
            return Err("metadata 必须是对象。".into());
        }
        match key {
            "interviewSessions" => {
                let messages = list_field(row, "messages")?;
                identified_rows(&Value::Array(messages.clone()))?;
                for message in messages {
                    if !matches!(message["role"].as_str(), Some("INTERVIEWER" | "ASSISTANT"))
                        || !message["text"].is_string()
                    {
                        return Err("面试发言的角色或正文格式无效。".into());
                    }
                    if message
                        .get("metadata")
                        .is_some_and(|v| !v.is_object() && !v.is_null())
                    {
                        return Err("发言 metadata 必须是对象。".into());
                    }
                }
            }
            "examSessions" | "materials" => {
                let field = if key == "examSessions" {
                    "questions"
                } else {
                    "entries"
                };
                let entries = list_field(row, field)?;
                identified_rows(&Value::Array(entries.clone()))?;
                for entry in entries {
                    strings(entry, &["questionText", "question", "answer"])?;
                    let object = entry.as_object_mut().unwrap();
                    object.entry("answer").or_insert_with(|| json!(""));
                    object
                        .entry(if key == "examSessions" {
                            "questionText"
                        } else {
                            "question"
                        })
                        .or_insert_with(|| json!(""));
                    if entry.get("screenshotRefs").is_some_and(|v| {
                        !v.as_array()
                            .is_some_and(|refs| refs.iter().all(Value::is_string))
                    }) {
                        return Err("截图引用必须是文字列表。".into());
                    }
                }
            }
            "freeChats" => {
                let messages = list_field(row, "messages")?;
                if messages.len() > 100000
                    || messages.iter().any(|m| {
                        !matches!(m["role"].as_str(), Some("user" | "assistant"))
                            || !m["content"].is_string()
                    })
                {
                    return Err("对话消息格式无效。".into());
                }
            }
            "questionBanks" => {
                let questions = list_field(row, "questions")?;
                if questions
                    .iter()
                    .any(|q| !q["question"].is_string() || !q["answer"].is_string())
                {
                    return Err("题库问题或答案格式无效。".into());
                }
                if list_field(row, "favorites")?
                    .iter()
                    .any(|value| !value.is_string())
                {
                    return Err("题库收藏必须是文字列表。".into());
                }
            }
            _ => {}
        }
    }
    Ok(())
}
fn normalize_document(mut data: Map<String, Value>) -> Result<Map<String, Value>, String> {
    if data
        .get("__schemaVersion")
        .is_some_and(|v| !v.as_u64().is_some_and(|version| version <= SCHEMA_VERSION))
    {
        return Err("本地数据版本不兼容，请使用更新版本；原文件已保留。".into());
    }
    if data
        .get("__revision")
        .is_some_and(|v| !v.as_u64().is_some_and(|revision| revision < u64::MAX))
    {
        return Err("本地数据修订号无效。".into());
    }
    for key in KEYS {
        if let Some(value) = data.get_mut(*key) {
            normalize_collection(key, value)?;
        }
    }
    data.insert("__schemaVersion".into(), SCHEMA_VERSION.into());
    Ok(data)
}

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
    let data = serde_json::from_slice::<Value>(&bytes)
        .map_err(|_| "本地数据损坏，已阻止覆盖；可在设置中恢复手动备份。".to_string())?
        .as_object()
        .cloned()
        .ok_or("本地数据格式无效，已阻止覆盖。")?;
    normalize_document(data)
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
/// 连续两次恢复常常落在同一秒里：撞名就加序号，绝不覆盖唯一的回退点。
fn unique_snapshot_path(dir: &Path, stamp: u64) -> std::path::PathBuf {
    let mut path = dir.join(format!("data.before-restore-{stamp}.json"));
    let mut suffix = 1;
    while path.exists() {
        path = dir.join(format!("data.before-restore-{stamp}-{suffix}.json"));
        suffix += 1;
    }
    path
}
fn snapshot(data: &Map<String, Value>) -> Value {
    json!({"revision":data.get("__revision").and_then(Value::as_u64).unwrap_or(0), "data":data})
}
fn migrate_folder(legacy: &Path, path: &Path) -> Result<(), String> {
    fs::create_dir_all(path.join("backups")).map_err(|e| e.to_string())?;
    if !path.join("data.json").exists() && legacy.join("data.json").exists() {
        let legacy_data = legacy.join("data.json");
        // 损坏或超限的旧文件不能阻塞启动：改名保留，让用户手动处理。
        match read_document(&legacy_data) {
            Ok(document) => {
                for name in ["data.previous.json", "data.manual-backup.json"] {
                    if legacy.join(name).exists() && !path.join("backups").join(name).exists() {
                        match read_document(&legacy.join(name)) {
                            Ok(backup) => atomic_write(&path.join("backups").join(name), &backup)?,
                            Err(_) => log::warn!(
                                "[storage] legacy backup {name} is invalid; original file preserved"
                            ),
                        }
                    }
                }
                atomic_write(&path.join("data.json"), &document)?;
            }
            Err(error) => {
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let target = legacy.join(format!("data.corrupt-{stamp}.json"));
                match fs::rename(&legacy_data, &target) {
                    Ok(()) => log::warn!(
                        "[storage] legacy data unreadable ({error}); moved to {}",
                        target.display()
                    ),
                    Err(rename_error) => log::warn!(
                        "[storage] legacy data unreadable ({error}); could not move it: {rename_error}"
                    ),
                }
            }
        }
    }
    Ok(())
}
fn folder(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    static MIGRATION: Mutex<()> = Mutex::new(());
    let _lock = MIGRATION.lock().map_err(|_| "存储迁移锁异常")?;
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("data");
    let legacy = app.path().app_data_dir().map_err(|e| e.to_string())?;
    migrate_folder(&legacy, &path)?;
    Ok(path)
}

#[cfg(test)]
mod migration_tests {
    use super::*;
    fn temporary() -> std::path::PathBuf {
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).unwrap();
        std::env::temp_dir().join(format!("mianxu-storage-{:x}", u64::from_le_bytes(random)))
    }
    #[test]
    fn migration_preserves_legacy_data_and_never_overwrites_newer_records() {
        let root = temporary();
        let legacy = root.join("legacy");
        let local = root.join("local");
        fs::create_dir_all(&legacy).unwrap();
        let document = serde_json::from_value(json!({"examSessions":[{"id":"old"}]})).unwrap();
        atomic_write(&legacy.join("data.json"), &document).unwrap();
        atomic_write(&legacy.join("data.manual-backup.json"), &document).unwrap();
        migrate_folder(&legacy, &local).unwrap();
        assert_eq!(
            read_document(&local.join("data.json")).unwrap(),
            normalize_document(document.clone()).unwrap()
        );
        assert!(legacy.join("data.json").is_file());
        assert!(local.join("backups/data.manual-backup.json").is_file());
        let new = serde_json::from_value(json!({"examSessions":[{"id":"new"}]})).unwrap();
        atomic_write(&local.join("data.json"), &new).unwrap();
        migrate_folder(&legacy, &local).unwrap();
        assert_eq!(
            read_document(&local.join("data.json")).unwrap(),
            normalize_document(new).unwrap()
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn corrupt_legacy_data_is_quarantined_and_not_migrated() {
        let root = temporary();
        let legacy = root.join("legacy");
        let local = root.join("local");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("data.json"), "broken").unwrap();
        // 读不出来的旧文档不再阻塞启动：改名保留，本地不产生 data.json。
        migrate_folder(&legacy, &local).unwrap();
        assert!(!local.join("data.json").exists());
        assert!(!legacy.join("data.json").exists());
        let quarantined = fs::read_dir(&legacy)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("data.corrupt-") && name.ends_with(".json"))
            })
            .expect("corrupt legacy data should be kept for manual recovery");
        assert_eq!(fs::read_to_string(quarantined).unwrap(), "broken");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn a_corrupt_old_backup_does_not_block_migration_of_valid_records() {
        let root = temporary();
        let legacy = root.join("legacy");
        let local = root.join("local");
        fs::create_dir_all(&legacy).unwrap();
        let data = serde_json::from_value(json!({"examSessions":[{"id":"valid"}]})).unwrap();
        atomic_write(&legacy.join("data.json"), &data).unwrap();
        fs::write(legacy.join("data.manual-backup.json"), "broken backup").unwrap();
        migrate_folder(&legacy, &local).unwrap();
        assert_eq!(
            read_document(&local.join("data.json")).unwrap(),
            normalize_document(data).unwrap()
        );
        assert_eq!(
            fs::read_to_string(legacy.join("data.manual-backup.json")).unwrap(),
            "broken backup"
        );
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
    mut value: Value,
) -> Result<Value, String> {
    if !KEYS.contains(&key.as_str()) {
        return Err("未知数据集合".into());
    }
    if value.to_string().len() as u64 > MAX_BYTES || expected.to_string().len() as u64 > MAX_BYTES {
        return Err("数据集合过大。".into());
    }
    normalize_collection(&key, &mut value)?;
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
    let changed_key = key.clone();
    next.insert(key, updated);
    let mut next = normalize_document(next)?;
    next.insert(
        "__revision".into(),
        (current
            .get("__revision")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            + 1)
        .into(),
    );
    write_previous_backup(&dir, current);
    atomic_write(&dir.join("data.json"), &next)?;
    let result = snapshot(&next);
    // 只广播改动的集合：其它窗口重读整份 data.json，会把每 2 秒一次的面试保存放大成 MB 级复制。
    if let Some(value) = next.get(&changed_key) {
        let _ = app.emit("ml-data-changed", json!({"key": changed_key, "value": value}));
    }
    *state = Some(next);
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
        // 用时间戳轮换，连续恢复两次也不会覆盖唯一的回退点。
        if dir.join("data.json").exists() {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            fs::copy(dir.join("data.json"), unique_snapshot_path(&dir, stamp))
                .map_err(|e| e.to_string())?;
            prune_restore_snapshots(&dir, 3);
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
    fn two_restores_within_one_second_keep_both_recovery_points() {
        let root = std::env::temp_dir().join(format!(
            "mianxu-restore-slots-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let first = unique_snapshot_path(&root, 7);
        fs::write(&first, "first").unwrap();
        let second = unique_snapshot_path(&root, 7);
        assert_ne!(first, second);
        fs::write(&second, "second").unwrap();
        assert_eq!(fs::read_to_string(&first).unwrap(), "first");
        assert_eq!(fs::read_to_string(&second).unwrap(), "second");
        fs::remove_dir_all(root).unwrap();
    }

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
    #[test]
    fn nested_records_reject_invalid_types_roles_ids_and_states() {
        for value in [
            json!({"interviewSessions":[{"id":"s","messages":"broken"}]}),
            json!({"interviewSessions":[{"id":"s","messages":[{"id":"m","role":"UNKNOWN","text":"x"}]}]}),
            json!({"interviewSessions":[{"id":"s","messages":[{"id":"m","role":"ASSISTANT","text":null}]}]}),
            json!({"interviewSessions":[{"id":"s","status":"INVALID"}]}),
            json!({"examSessions":[{"id":"s","questions":null}]}),
            json!({"examSessions":[{"id":"s","questions":[{"id":"q","answer":[]}]}]}),
            json!({"examSessions":[{"id":"s","questions":[{"id":"q"},{"id":"q"}]}]}),
            json!({"materials":[{"id":"m","entries":{}}]}),
            json!({"freeChats":[{"id":"s","messages":[{"role":"user","content":42}]}]}),
            json!({"questionBanks":[{"id":"q","questions":[{"question":42,"answer":"x"}]}]}),
            json!({"__schemaVersion":2}),
            json!({"__schemaVersion":"1"}),
        ] {
            assert!(
                normalize_document(value.as_object().unwrap().clone()).is_err(),
                "accepted {value}"
            );
        }
    }
    #[test]
    fn legacy_omitted_lists_migrate_without_rewriting_source_files() {
        let old = json!({"examSessions":[{"id":"s","questions":[{"id":"q"}]}],"materials":[{"id":"m"}],"customLegacyField":"preserved"});
        let source = old.as_object().unwrap().clone();
        let migrated = normalize_document(source.clone()).unwrap();
        assert_eq!(migrated["__schemaVersion"], 1);
        assert_eq!(migrated["examSessions"][0]["questions"][0]["answer"], "");
        assert_eq!(migrated["materials"][0]["entries"], json!([]));
        assert_eq!(migrated["customLegacyField"], "preserved");
        assert_eq!(source, old.as_object().unwrap().clone());
        assert_eq!(normalize_document(migrated.clone()).unwrap(), migrated);
    }
    #[test]
    fn corrupt_nested_json_is_not_accepted_from_disk_or_modified_on_failure() {
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).unwrap();
        let path = std::env::temp_dir().join(format!(
            "mianxu-schema-{:x}.json",
            u64::from_le_bytes(random)
        ));
        let text = r#"{"examSessions":[{"id":"s","questions":false}]}"#;
        fs::write(&path, text).unwrap();
        assert!(read_document(&path).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
        fs::remove_file(&path).unwrap();
    }
}
