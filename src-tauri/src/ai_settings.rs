//! BYOK storage. DPAPI on Windows, Keychain-backed encryption on macOS; events never carry keys.
use base64::Engine;
use serde_json::{Value, json};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tauri_plugin_store::StoreExt;

const KEY: &str = "ai.settings.v2";
#[derive(Default)]
pub struct AiSettingsLock(Mutex<()>);

#[cfg(windows)]
pub(crate) fn crypt(input: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    use windows::{
        Win32::{
            Foundation::{HLOCAL, LocalFree},
            Security::Cryptography::{
                CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
            },
        },
        core::PCWSTR,
    };
    let source = CRYPT_INTEGER_BLOB {
        cbData: input.len() as u32,
        pbData: input.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let result = unsafe {
        if protect {
            CryptProtectData(
                &source,
                PCWSTR::null(),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &source,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    result.map_err(|_| {
        "无法读取或保存加密密钥。请在原 Windows 账户下使用，或重新填写密钥".to_string()
    })?;
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe { LocalFree(Some(HLOCAL(output.pbData.cast()))) };
    Ok(bytes)
}
#[cfg(target_os = "macos")]
pub(crate) fn crypt(input: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    crate::macos_secrets::crypt(input, protect)
}
#[cfg(not(any(windows, target_os = "macos")))]
pub(crate) fn crypt(_: &[u8], _: bool) -> Result<Vec<u8>, String> {
    Err("此构建的密钥加密存储仅支持 Windows/macOS；免密本地连接不受影响".into())
}
fn transform_keys(config: &mut Value, encrypt: bool) -> Result<(), String> {
    let providers = config["providers"]
        .as_array_mut()
        .ok_or("连接列表格式无效")?;
    for provider in providers {
        let object = provider.as_object_mut().ok_or("连接格式无效")?;
        if encrypt {
            let key = object
                .remove("apiKey")
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default();
            let encrypted = if key.is_empty() {
                String::new()
            } else {
                base64::engine::general_purpose::STANDARD.encode(crypt(key.as_bytes(), true)?)
            };
            object.insert("encryptedApiKey".into(), encrypted.into());
        } else {
            let encrypted = object
                .remove("encryptedApiKey")
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default();
            let key = if encrypted.is_empty() {
                String::new()
            } else {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encrypted)
                    .map_err(|_| "密钥数据损坏，请重新配置")?;
                String::from_utf8(crypt(&bytes, false)?).map_err(|_| "密钥数据损坏，请重新配置")?
            };
            object.insert("apiKey".into(), key.into());
        }
    }
    Ok(())
}
fn bailian_region(host: &str) -> Option<&'static str> {
    for (region, public, suffix) in [
        ("beijing", "dashscope.aliyuncs.com", ".cn-beijing.maas.aliyuncs.com"),
        ("singapore", "dashscope-intl.aliyuncs.com", ".ap-southeast-1.maas.aliyuncs.com"),
    ] {
        let workspace = host.strip_suffix(suffix).is_some_and(|prefix|
            !prefix.is_empty() && prefix.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'));
        if host == public || workspace { return Some(region); }
    }
    None
}
fn validate(config: &Value) -> Result<(), String> {
    if let Some(mode) = config.get("speechInputMode") {
        if !matches!(mode.as_str(), Some("auto" | "segmented" | "file" | "realtime")) {
            return Err("语音输入模式无效".into());
        }
    }
    if let Some(endpoint) = config.get("realtimeEndpoint") {
        let endpoint = endpoint.as_str().ok_or("实时语音地址无效")?;
        let url = tauri::Url::parse(endpoint).map_err(|_| "实时语音地址无效")?;
        let host = url.host_str().unwrap_or_default();
        if url.scheme() != "wss" || url.path() != "/api-ws/v1/inference" || url.query().is_some() || url.fragment().is_some()
            || !url.username().is_empty() || url.password().is_some() || url.port().is_some()
            || bailian_region(host).is_none() {
            return Err("持续实时语音仅支持百炼北京或新加坡地域的官方 WSS 地址".into());
        }
    }
    if let Some(vocabulary) = config.get("realtimeVocabularyId") {
        let vocabulary = vocabulary.as_str().ok_or("热词表 ID 无效")?;
        if vocabulary.len() > 200 || !vocabulary.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') {
            return Err("热词表 ID 无效".into());
        }
    }
    if config["speechInputMode"] == "realtime" && !config["routes"]["stt"].is_null()
        && !matches!(config["routes"]["stt"]["modelId"].as_str(),
            Some("paraformer-realtime-v2" | "fun-asr-realtime" | "fun-asr-realtime-2026-02-28")) {
        return Err("持续实时模式请选择 Fun-ASR-Realtime 或 paraformer-realtime-v2".into());
    }
    if config["speechInputMode"] == "realtime" {
        let route = &config["routes"]["stt"];
        let provider_region = config["providers"].as_array()
            .and_then(|providers| providers.iter().find(|provider| provider["id"] == route["providerId"]))
            .and_then(|provider| provider["baseUrl"].as_str())
            .and_then(|base| tauri::Url::parse(base).ok())
            .filter(|url| url.scheme() == "https" && url.port().is_none() && url.username().is_empty()
                && url.password().is_none() && url.query().is_none() && url.fragment().is_none()
                && url.path().trim_end_matches('/') == "/compatible-mode/v1")
            .and_then(|url| bailian_region(url.host_str().unwrap_or_default()));
        let endpoint_region = config["realtimeEndpoint"].as_str()
            .and_then(|endpoint| tauri::Url::parse(endpoint).ok())
            .and_then(|url| bailian_region(url.host_str().unwrap_or_default()));
        if let (Some(provider), Some(endpoint)) = (provider_region, endpoint_region) {
            if provider != endpoint { return Err("实时语音地址与语音转写连接的地域不一致，请清空实时地址以自动匹配".into()); }
        }
        if endpoint_region.or(provider_region) == Some("singapore") && !route.is_null() && route["modelId"] != "fun-asr-realtime" {
            return Err("新加坡持续实时识别请选择 fun-asr-realtime 稳定版".into());
        }
    }
    if config["version"] != 2 || config.to_string().len() > 4_000_000 {
        return Err("AI 配置版本或大小无效".into());
    }
    let providers = config["providers"].as_array().ok_or("连接列表无效")?;
    if providers.len() > 20 {
        return Err("最多保存 20 个连接".into());
    }
    let mut ids = std::collections::HashSet::new();
    for provider in providers {
        for (field, max) in [("id", 128), ("name", 80), ("baseUrl", 2048)] {
            let text = provider[field].as_str().ok_or("连接字段无效")?;
            if text.trim().is_empty()
                || text.chars().count() > max
                || text.chars().any(char::is_control)
            {
                return Err("连接字段无效".into());
            }
        }
        if !ids.insert(provider["id"].as_str().unwrap()) {
            return Err("连接 ID 重复".into());
        }
        let url =
            tauri::Url::parse(provider["baseUrl"].as_str().unwrap()).map_err(|_| "接口地址无效")?;
        if !["http", "https"].contains(&url.scheme())
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("接口地址需为不含凭据和查询参数的 HTTP(S) 地址".into());
        }
        if ![Some("bearer"), Some("none")].contains(&provider["authMode"].as_str()) {
            return Err("认证方式无效".into());
        }
        let key = provider["apiKey"].as_str().ok_or("密钥字段无效")?;
        if key.len() > 8192 || key.chars().any(char::is_control) {
            return Err("密钥格式无效".into());
        }
        let models = provider["models"].as_array().ok_or("模型列表无效")?;
        if models.len() > 2000 {
            return Err("模型过多".into());
        }
        let mut model_ids = std::collections::HashSet::new();
        for model in models {
            let id = model["id"].as_str().ok_or("模型 ID 无效")?;
            if id.trim().is_empty()
                || id.len() > 1024
                || id.chars().any(char::is_control)
                || !model_ids.insert(id)
            {
                return Err("模型 ID 无效或重复".into());
            }
        }
    }
    for role in ["chat", "vision", "stt", "tts"] {
        let route = &config["routes"][role];
        if route.is_null() {
            continue;
        }
        let provider = providers
            .iter()
            .find(|p| p["id"] == route["providerId"])
            .ok_or("用途引用了不存在的连接")?;
        if !provider["models"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == route["modelId"])
        {
            return Err("用途引用了不存在的模型".into());
        }
        if provider["authMode"] == "bearer"
            && provider["apiKey"].as_str().unwrap().trim().is_empty()
        {
            return Err("用途使用的连接缺少密钥".into());
        }
    }
    if !config["timeoutMs"]
        .as_u64()
        .is_some_and(|n| (5000..=300000).contains(&n))
    {
        return Err("超时时间无效".into());
    }
    if !config["ttsVoice"]
        .as_str()
        .is_some_and(|s| !s.trim().is_empty() && s.len() <= 400 && !s.chars().any(char::is_control))
    {
        return Err("音色无效".into());
    }
    Ok(())
}

fn migrate(legacy: Value) -> Value {
    let local = legacy["baseUrl"]
        .as_str()
        .and_then(|s| tauri::Url::parse(s).ok())
        .and_then(|u| u.host_str().map(str::to_owned))
        .is_some_and(|host| ["localhost", "127.0.0.1", "[::1]"].contains(&host.as_str()));
    let model = |field: &str, fallback: &str| {
        legacy[field]
            .as_str()
            .unwrap_or(fallback)
            .trim()
            .to_string()
    };
    let chat = model("chatModel", "gpt-4o-mini");
    let names = [
        chat.clone(),
        model("visionModel", ""),
        model("sttModel", "whisper-1"),
        model("ttsModel", ""),
    ];
    let mut models = Vec::new();
    for id in &names {
        if !id.is_empty() && !models.iter().any(|m: &Value| m["id"] == *id) {
            models.push(json!({"id":id,"name":id,"source":"custom"}));
        }
    }
    let route = |id: &str| {
        if id.is_empty() {
            Value::Null
        } else {
            json!({"providerId":"legacy","modelId":id})
        }
    };
    json!({"version":2, "providers":[{"id":"legacy", "name":"原有 AI 接口", "baseUrl":legacy["baseUrl"].as_str().unwrap_or("https://api.openai.com/v1"), "apiKey":legacy["apiKey"].as_str().unwrap_or(""), "authMode":if local && legacy["apiKey"].as_str().is_none_or(|s|s.is_empty()) {"none"} else {"bearer"}, "models":models, "lastFetchedAt":null}], "routes":{"chat":route(&names[0]),"vision":route(&names[1]),"stt":route(&names[2]),"tts":route(&names[3])}, "timeoutMs":90000,"ttsVoice":"alloy"})
}
fn persist(app: &AppHandle, config: &Value) -> Result<(), String> {
    let mut encrypted = config.clone();
    transform_keys(&mut encrypted, true)?;
    let store = app.store("store.json").map_err(|_| "无法打开设置文件")?;
    let previous = store.get(KEY);
    let legacy = store.get("ai.provider");
    store.set(KEY, encrypted);
    store.delete("ai.provider");
    if store.save().is_err() {
        if let Some(value) = previous {
            store.set(KEY, value);
        } else {
            store.delete(KEY);
        }
        if let Some(value) = legacy {
            store.set("ai.provider", value);
        }
        return Err("AI 配置保存失败，请检查磁盘和文件权限".into());
    }
    Ok(())
}
#[tauri::command]
pub fn cmd_ai_load_settings(
    app: AppHandle,
    lock: tauri::State<AiSettingsLock>,
) -> Result<Option<Value>, String> {
    let _guard = lock.0.lock().map_err(|_| "AI 配置忙")?;
    let store = app.store("store.json").map_err(|_| "无法打开设置文件")?;
    if let Some(mut config) = store.get(KEY) {
        transform_keys(&mut config, false)?;
        return Ok(Some(config));
    }
    if let Some(legacy) = store.get("ai.provider") {
        let config = migrate(legacy);
        persist(&app, &config)?;
        return Ok(Some(config));
    }
    Ok(None)
}
#[tauri::command]
pub fn cmd_ai_save_settings(
    app: AppHandle,
    lock: tauri::State<AiSettingsLock>,
    config: Value,
) -> Result<(), String> {
    let _guard = lock.0.lock().map_err(|_| "AI 配置忙")?;
    validate(&config)?;
    persist(&app, &config)?;
    // No configuration or credentials in cross-window events.
    let _ = app.emit("ai-settings-changed", ());
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn speech_input_mode_is_optional_and_validated() {
        let mut value = migrate(json!({"apiKey":"test-credential"}));
        validate(&value).unwrap();
        for mode in ["auto", "segmented", "file"] {
            value["speechInputMode"] = mode.into();
            validate(&value).unwrap();
        }
        value["speechInputMode"] = "unknown".into();
        assert!(validate(&value).is_err());
    }
    #[test]
    fn fun_asr_realtime_settings_can_be_saved() {
        for model in ["fun-asr-realtime", "fun-asr-realtime-2026-02-28"] {
            let mut value = migrate(json!({"apiKey":"synthetic","sttModel":model}));
            value["speechInputMode"] = "realtime".into();
            value["realtimeEndpoint"] = "wss://demo.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference".into();
            validate(&value).unwrap();
        }
    }
    #[test]
    fn singapore_settings_infer_region_and_reject_mismatched_endpoints_and_models() {
        let mut value = migrate(json!({"apiKey":"synthetic","sttModel":"fun-asr-realtime"}));
        value["speechInputMode"] = "realtime".into();
        let provider_id = value["routes"]["stt"]["providerId"].as_str().unwrap().to_owned();
        let provider = value["providers"].as_array_mut().unwrap().iter_mut()
            .find(|provider| provider["id"] == provider_id).unwrap();
        provider["baseUrl"] = "https://ws-example.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1".into();
        validate(&value).unwrap();
        for endpoint in ["wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference", "wss://ws-example.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference"] {
            value["realtimeEndpoint"] = endpoint.into(); validate(&value).unwrap();
        }
        for endpoint in ["wss://dashscope.aliyuncs.com/api-ws/v1/inference", "wss://ws-example.ap-southeast-1.maas.aliyuncs.com.evil.test/api-ws/v1/inference", "wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference?key=secret"] {
            value["realtimeEndpoint"] = endpoint.into(); assert!(validate(&value).is_err());
        }
        value.as_object_mut().unwrap().remove("realtimeEndpoint");
        for model in ["fun-asr-realtime-2026-02-28", "paraformer-realtime-v2"] {
            value["routes"]["stt"]["modelId"] = model.into(); assert!(validate(&value).is_err());
        }
    }
    #[test]
    fn realtime_settings_only_accept_the_official_service_and_matching_model() {
        let mut value = migrate(json!({"apiKey":"synthetic","sttModel":"paraformer-realtime-v2"}));
        value["speechInputMode"] = "realtime".into();
        value["realtimeEndpoint"] = "wss://demo.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference".into();
        value["realtimeVocabularyId"] = "vocab-123".into();
        validate(&value).unwrap();
        for endpoint in ["ws://dashscope.aliyuncs.com/api-ws/v1/inference", "wss://evil.test/api-ws/v1/inference", "wss://dashscope.aliyuncs.com/api-ws/v1/inference?key=secret"] {
            value["realtimeEndpoint"] = endpoint.into();
            assert!(validate(&value).is_err());
        }
        value["realtimeEndpoint"] = "wss://dashscope.aliyuncs.com/api-ws/v1/inference".into();
        value["routes"]["stt"]["modelId"] = "mimo-asr".into();
        assert!(validate(&value).is_err());
    }
    #[test]
    fn legacy_migration_preserves_models_and_separate_routes() {
        let value = migrate(
            json!({"apiKey":"test-credential","chatModel":"custom/chat", "visionModel":"custom/vision", "sttModel":"","ttsModel":""}),
        );
        assert_eq!(value["routes"]["vision"]["modelId"], "custom/vision");
        assert!(value["routes"]["stt"].is_null());
        validate(&value).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn credentials_roundtrip_and_never_persist_as_plaintext() {
        let original = migrate(json!({"apiKey":"dummy-credential-for-test"}));
        let mut stored = original.clone();
        transform_keys(&mut stored, true).unwrap();
        assert!(!stored.to_string().contains("dummy-credential-for-test"));
        assert!(stored["providers"][0].get("apiKey").is_none());
        transform_keys(&mut stored, false).unwrap();
        assert_eq!(stored, original);
    }
}
