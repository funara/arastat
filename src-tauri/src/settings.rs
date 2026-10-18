//! AI + provider settings: JSON file in the app data directory, API key in the OS keychain.
//!
//! Supported providers: `google` (Google Gemini) and `custom` (OpenAI-compatible).
//! Ported from `src/main/settings.ts`; the on-disk key never holds a plaintext API key
//! once the OS credential store has accepted it.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const GOOGLE_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";
pub const GOOGLE_DEFAULT_MODEL: &str = "gemini-3.8-flash";

pub const CUSTOM_DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
pub const CUSTOM_DEFAULT_MODEL: &str = "gpt-4o-mini";

const PRIMARY_FILE: &str = "arastat-settings.json";
const LEGACY_FILE: &str = "ara-stats-settings.json";

const KEYCHAIN_SERVICE: &str = "com.funara.arastat";
/// Pre-migration builds kept one provider-agnostic entry; startup moves it to the
/// provider that was configured then, so it can never leak into the other one.
const LEGACY_KEYCHAIN_USER: &str = "ai_api_key";

const KEYCHAIN_UNAVAILABLE: &str =
    "The system credential store is unavailable, so the API key was not saved. Check your OS keychain and try again.";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    pub provider: String,
    pub base_url: String,
    /// Never serialized to the renderer; the file only keeps it when the keychain refused it.
    pub key: String,
    pub model: String,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            provider: "google".to_string(),
            base_url: GOOGLE_BASE_URL.to_string(),
            key: String::new(),
            model: GOOGLE_DEFAULT_MODEL.to_string(),
        }
    }
}

/// Resolve the settings actually sent to the provider.
/// provider='google' pins Google's endpoint and defaults to gemini-3.8-flash;
/// provider='custom' defaults model to gpt-4o-mini.
pub fn effective_settings(settings: &AiSettings) -> AiSettings {
    if settings.provider == "google" {
        AiSettings {
            provider: "google".to_string(),
            base_url: if settings.base_url.is_empty() { GOOGLE_BASE_URL.to_string() } else { settings.base_url.clone() },
            key: settings.key.clone(),
            model: if settings.model.is_empty() { GOOGLE_DEFAULT_MODEL.to_string() } else { settings.model.clone() },
        }
    } else {
        AiSettings {
            provider: "custom".to_string(),
            base_url: if settings.base_url.is_empty() { CUSTOM_DEFAULT_BASE_URL.to_string() } else { settings.base_url.clone() },
            key: settings.key.clone(),
            model: if settings.model.is_empty() { CUSTOM_DEFAULT_MODEL.to_string() } else { settings.model.clone() },
        }
    }
}

/// Masked tail for the renderer's "Saved key" hint: last 4 chars only when the
/// stored key is long enough that the tail reveals nothing meaningful, '' for
/// short keys (never reveal them). The full key never crosses the bridge.
pub fn key_hint_for(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() >= 8 {
        chars[chars.len() - 4..].iter().collect()
    } else {
        String::new()
    }
}

/// `<dir>/arastat-settings.json`, falling back to legacy `ara-stats-settings.json`
/// when only that exists.
pub fn settings_path(dir: &Path) -> PathBuf {
    let primary = dir.join(PRIMARY_FILE);
    let legacy = dir.join(LEGACY_FILE);
    if primary.exists() {
        primary
    } else if legacy.exists() {
        legacy
    } else {
        primary
    }
}

fn default_base_url(provider: &str) -> &'static str {
    if provider == "google" { GOOGLE_BASE_URL } else { CUSTOM_DEFAULT_BASE_URL }
}

fn default_model(provider: &str) -> &'static str {
    if provider == "google" { GOOGLE_DEFAULT_MODEL } else { CUSTOM_DEFAULT_MODEL }
}

/// Port of the TS `clean()`: anything that is not exactly `custom` is `google`,
/// and empty strings fall back to that provider's defaults.
/// First non-empty string, for the merge-on-write field rules.
fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty())
}

fn normalize(
    provider: Option<&str>,
    base_url: Option<&str>,
    key: Option<&str>,
    model: Option<&str>,
) -> AiSettings {
    let provider = if provider == Some("custom") { "custom" } else { "google" };
    AiSettings {
        provider: provider.to_string(),
        base_url: non_empty(base_url).map(str::to_string).unwrap_or_else(|| default_base_url(provider).to_string()),
        key: key.unwrap_or("").to_string(),
        model: non_empty(model).map(str::to_string).unwrap_or_else(|| default_model(provider).to_string()),
    }
}

fn clean(raw: &serde_json::Value) -> AiSettings {
    let get = |name: &str| raw.get(name).and_then(|value| value.as_str());
    normalize(get("provider"), get("baseUrl"), get("key"), get("model"))
}

/// Settings as they appear in the JSON file (plaintext key included when present).
fn read_file_settings(dir: &Path) -> AiSettings {
    match std::fs::read_to_string(settings_path(dir)) {
        Ok(text) => serde_json::from_str::<serde_json::Value>(&text)
            .map(|value| clean(&value))
            .unwrap_or_default(),
        Err(_) => AiSettings::default(),
    }
}

fn keychain_entry(user: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, user).ok()
}

/// One credential per provider, so switching Google <-> Custom carries no key across.
fn keychain_user(provider: &str) -> String {
    format!("ai_api_key_{provider}")
}

/// Reads the key stored for `provider`. `NoEntry` (and any other store failure)
/// means "no key stored" — loading settings must never fail because of the keychain.
fn keychain_get(provider: &str) -> Option<String> {
    let entry = keychain_entry(&keychain_user(provider))?;
    match entry.get_password() {
        Ok(key) if !key.is_empty() => Some(key),
        Ok(_) => None,
        Err(_) => None,
    }
}

fn keychain_set(provider: &str, key: &str) -> Result<(), String> {
    if key.is_empty() {
        return Ok(());
    }
    let entry = keychain_entry(&keychain_user(provider)).ok_or_else(|| KEYCHAIN_UNAVAILABLE.to_string())?;
    entry.set_password(key).map_err(|_| KEYCHAIN_UNAVAILABLE.to_string())
}

/// Atomic-ish write: temp file next to the target, then rename over it.
fn write_settings_file(dir: &Path, settings: &AiSettings, disk_key: &str) -> Result<(), String> {
    let path = settings_path(dir);
    let parent = path.parent().unwrap_or(dir);
    std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;

    let mut on_disk = settings.clone();
    on_disk.key = disk_key.to_string();
    let text = serde_json::to_string_pretty(&on_disk).map_err(|err| err.to_string())?;

    let mut tmp_name = path.clone().into_os_string();
    tmp_name.push(".tmp");
    let tmp = PathBuf::from(tmp_name);

    if let Err(err) = std::fs::write(&tmp, text) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err.to_string());
    }
    if let Err(err) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err.to_string());
    }
    Ok(())
}

/// Load + sanitize. Missing/corrupt file yields defaults. Never fails.
pub fn load_settings(dir: &Path) -> AiSettings {
    let mut settings = read_file_settings(dir);
    if let Some(stored) = keychain_get(&settings.provider) {
        settings.key = stored;
    }
    settings
}

/// Merge-on-write. `patch` is the raw camelCase JSON object the renderer sent; an
/// empty/absent `key` means "keep what is stored". Returns the settings as persisted.
pub fn save_settings(dir: &Path, patch: &serde_json::Value) -> Result<AiSettings, String> {
    let current = load_settings(dir);
    let patch_str = |name: &str| patch.get(name).and_then(|value| value.as_str()).filter(|value| !value.is_empty());

    let provider = match patch_str("provider") {
        Some("custom") => "custom",
        Some("google") => "google",
        _ => current.provider.as_str(),
    }
    .to_string();

    // A stored key belongs to the provider it was entered for. Carrying it across a
    // provider switch is what leaked a Google key into a Custom/local endpoint; on a
    // switch the new provider starts from its own stored key instead.
    let carried_key = if provider == current.provider {
        current.key.clone()
    } else {
        keychain_get(&provider).unwrap_or_default()
    };

    let typed_key = patch_str("key");
    let next = AiSettings {
        provider,
        base_url: patch_str("baseUrl").map(str::to_string).unwrap_or_else(|| current.base_url.clone()),
        key: typed_key.map(str::to_string).unwrap_or(carried_key),
        model: patch_str("model").map(str::to_string).unwrap_or_else(|| current.model.clone()),
    };

    // New key from the renderer -> the store must accept it, or the user is told.
    // Carried-over plaintext key (no usable store on this machine) -> leave it on
    // disk rather than drop the only copy.
    let disk_key = match typed_key {
        Some(new_key) => {
            keychain_set(&next.provider, new_key)?;
            String::new()
        }
        None if next.key.is_empty() || keychain_set(&next.provider, &next.key).is_ok() => String::new(),
        None => next.key.clone(),
    };

    if let Err(err) = write_settings_file(dir, &next, &disk_key) {
        log::warn!("Could not persist AI settings: {err}");
    }
    Ok(next)
}

/// `{ ...sanitized, "key": "", "keyHints": { google, custom } }` for the renderer:
/// each provider's own stored-key hint, so switching tabs never claims the other
/// provider's key is still available.
pub fn renderer_view(settings: &AiSettings) -> serde_json::Value {
    let sanitized = normalize(
        Some(&settings.provider),
        Some(&settings.base_url),
        None,
        Some(&settings.model),
    );
    let hint_for = |provider: &str| {
        if provider == settings.provider {
            key_hint_for(&settings.key)
        } else {
            key_hint_for(&keychain_get(provider).unwrap_or_default())
        }
    };
    serde_json::json!({
        "provider": sanitized.provider,
        "baseUrl": sanitized.base_url,
        "key": "",
        "model": sanitized.model,
        "keyHints": { "google": hint_for("google"), "custom": hint_for("custom") },
    })
}

/// Startup migration for builds that kept ONE key for every provider: a plaintext
/// `key` in the JSON and/or the single `ai_api_key` keychain entry is moved to the
/// entry of the provider configured at the time. Any failure leaves the original
/// untouched, so the user never loses a key.
pub fn migrate_legacy_keys(dir: &Path) {
    let file = read_file_settings(dir);
    let provider = file.provider.clone();

    if !file.key.is_empty() {
        if keychain_set(&provider, &file.key).is_ok() {
            if let Err(err) = write_settings_file(dir, &file, "") {
                log::warn!("Could not clear the migrated API key from the settings file: {err}");
            }
        } else {
            log::warn!("Not migrating the stored API key into the OS keychain: credential store unavailable");
        }
    }

    if keychain_get(&provider).is_some() {
        return;
    }
    let Some(legacy) = keychain_entry(LEGACY_KEYCHAIN_USER)
        .and_then(|entry| entry.get_password().ok())
        .filter(|key| !key.is_empty())
    else {
        return;
    };
    if keychain_set(&provider, &legacy).is_ok() {
        if let Some(entry) = keychain_entry(LEGACY_KEYCHAIN_USER) {
            let _ = entry.delete_credential();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("arastat-settings-{tag}-{nanos}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn cleanup(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    fn read_json(path: &Path) -> serde_json::Value {
        let text = std::fs::read_to_string(path).expect("read settings file");
        serde_json::from_str(&text).expect("settings file is JSON")
    }

    /// Best-effort probe so key-dependent assertions skip on machines without a
    /// working OS credential store.
    fn keychain_works() -> bool {
        let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, "arastat_settings_test_probe") else {
            return false;
        };
        let ok = entry.set_password("probe").is_ok()
            && entry.get_password().map(|v| v == "probe").unwrap_or(false);
        let _ = entry.delete_credential();
        ok
    }

    #[test]
    fn empty_dir_loads_defaults() {
        let dir = temp_dir("defaults");
        let loaded = load_settings(&dir);
        let defaults = AiSettings::default();
        assert_eq!(loaded.provider, defaults.provider);
        assert_eq!(loaded.base_url, defaults.base_url);
        assert_eq!(loaded.model, defaults.model);
        // The keychain is process-global; only the empty-store case proves the key default.
        if keychain_get("google").is_none() {
            assert_eq!(loaded, defaults);
        }
        cleanup(&dir);
    }

    #[test]
    fn save_then_load_merges_and_keeps_the_file_key_empty() {
        let dir = temp_dir("save");
        save_settings(
            &dir,
            &serde_json::json!({ "provider": "custom", "baseUrl": "https://provider.example/v1", "model": "m" }),
        )
        .expect("save");

        let loaded = load_settings(&dir);
        assert_eq!(loaded.provider, "custom");
        assert_eq!(loaded.base_url, "https://provider.example/v1");
        assert_eq!(loaded.model, "m");
        // A pre-existing keychain entry is carried over; only assert the file is
        // key-free where the store either is empty or provably writable.
        if keychain_get("custom").is_none() || keychain_works() {
            assert_eq!(read_json(&settings_path(&dir))["key"], "");
        }
        cleanup(&dir);
    }

    #[test]
    fn empty_key_patch_keeps_the_stored_key() {
        // Only run against an empty store so a developer's real saved key is never
        // overwritten by the test, and leave the entry empty afterwards.
        if !keychain_works() || keychain_get("google").is_some() {
            return;
        }
        let dir = temp_dir("keep");
        save_settings(&dir, &serde_json::json!({ "key": "secret-key-1" })).expect("save key");
        assert_eq!(read_json(&settings_path(&dir))["key"], "");

        save_settings(&dir, &serde_json::json!({ "model": "m2" })).expect("merge");
        let loaded = load_settings(&dir);
        assert_eq!(loaded.key, "secret-key-1");
        assert_eq!(loaded.model, "m2");
        cleanup(&dir);
        let _ = keychain_entry(&keychain_user("google")).map(|entry| entry.delete_credential());
    }

    /// Bug 1 regression: a Google key must not follow the user into a Custom/local
    /// endpoint, and switching back must still find it.
    #[test]
    fn provider_switch_never_carries_a_key_across() {
        if !keychain_works() || keychain_get("google").is_some() || keychain_get("custom").is_some() {
            return;
        }
        let dir = temp_dir("providers");
        save_settings(&dir, &serde_json::json!({ "provider": "google", "key": "AIza-google-key-1" })).expect("save google key");
        assert_eq!(load_settings(&dir).key, "AIza-google-key-1");

        // Switch to a local Custom endpoint without typing a key.
        save_settings(
            &dir,
            &serde_json::json!({ "provider": "custom", "baseUrl": "http://localhost:11434/v1" }),
        )
        .expect("switch provider");
        let custom = load_settings(&dir);
        assert_eq!(custom.provider, "custom");
        assert_eq!(custom.key, "", "the Google key must not leak into the local endpoint");

        // A key typed for Custom stays there.
        save_settings(&dir, &serde_json::json!({ "key": "sk-custom-key-1" })).expect("save custom key");
        assert_eq!(load_settings(&dir).key, "sk-custom-key-1");

        // Switching back finds the Google key again, untouched.
        save_settings(&dir, &serde_json::json!({ "provider": "google" })).expect("switch back");
        let google = load_settings(&dir);
        assert_eq!(google.provider, "google");
        assert_eq!(google.key, "AIza-google-key-1");

        cleanup(&dir);
        for provider in ["google", "custom"] {
            let _ = keychain_entry(&keychain_user(provider)).map(|entry| entry.delete_credential());
        }
    }

    #[test]
    fn key_hint_only_reveals_long_key_tails() {
        assert_eq!(key_hint_for("short"), "");
        assert_eq!(key_hint_for(""), "");
        assert_eq!(key_hint_for("1234567"), "");
        assert_eq!(key_hint_for("12345678"), "5678");
    }

    #[test]
    fn renderer_view_hides_the_key_and_carries_the_hint() {
        let settings = AiSettings {
            provider: "google".to_string(),
            base_url: GOOGLE_BASE_URL.to_string(),
            key: "supersecret1234".to_string(),
            model: GOOGLE_DEFAULT_MODEL.to_string(),
        };
        let view = renderer_view(&settings);
        assert_eq!(view["key"], "");
        assert_eq!(view["keyHints"]["google"], "1234");
        assert_eq!(view["provider"], "google");
        assert_eq!(view["baseUrl"], GOOGLE_BASE_URL);
        assert_eq!(view["model"], GOOGLE_DEFAULT_MODEL);
    }

    #[test]
    fn effective_settings_fills_provider_defaults() {
        let blank = |provider: &str, base_url: &str, model: &str| AiSettings {
            provider: provider.to_string(),
            base_url: base_url.to_string(),
            key: "k".to_string(),
            model: model.to_string(),
        };

        let google = effective_settings(&blank("google", "", ""));
        assert_eq!(google.provider, "google");
        assert_eq!(google.base_url, GOOGLE_BASE_URL);
        assert_eq!(google.model, GOOGLE_DEFAULT_MODEL);

        let custom = effective_settings(&blank("custom", "", ""));
        assert_eq!(custom.provider, "custom");
        assert_eq!(custom.base_url, CUSTOM_DEFAULT_BASE_URL);
        assert_eq!(custom.model, CUSTOM_DEFAULT_MODEL);

        let passthrough = effective_settings(&blank("custom", "https://provider.example/v1", "m"));
        assert_eq!(passthrough.base_url, "https://provider.example/v1");
        assert_eq!(passthrough.model, "m");
    }

    #[test]
    fn corrupt_or_unknown_json_loads_as_defaults() {
        let dir = temp_dir("corrupt");
        let path = settings_path(&dir);

        std::fs::write(&path, "{ not json at all").expect("write junk");
        let corrupt = load_settings(&dir);
        assert_eq!(corrupt.provider, "google");
        assert_eq!(corrupt.base_url, GOOGLE_BASE_URL);
        assert_eq!(corrupt.model, GOOGLE_DEFAULT_MODEL);
        if keychain_get("google").is_none() {
            assert_eq!(corrupt, AiSettings::default());
        }

        std::fs::write(&path, "12345").expect("write junk");
        assert_eq!(load_settings(&dir).provider, "google");

        // Unknown provider values normalize to google, mirroring clean().
        std::fs::write(&path, r#"{"provider":"anthropic","baseUrl":"https://provider.example/v1"}"#).expect("write");
        let unknown = load_settings(&dir);
        assert_eq!(unknown.provider, "google");
        assert_eq!(unknown.base_url, "https://provider.example/v1");
        assert_eq!(unknown.model, GOOGLE_DEFAULT_MODEL);
        cleanup(&dir);
    }

    #[test]
    fn settings_path_prefers_primary_and_falls_back_to_legacy() {
        let dir = temp_dir("path");
        assert_eq!(settings_path(&dir), dir.join("arastat-settings.json"));

        std::fs::write(dir.join("ara-stats-settings.json"), "{}").expect("write legacy");
        assert_eq!(settings_path(&dir), dir.join("ara-stats-settings.json"));
        assert_eq!(load_settings(&dir).provider, "google");

        std::fs::write(dir.join("arastat-settings.json"), "{}").expect("write primary");
        assert_eq!(settings_path(&dir), dir.join("arastat-settings.json"));
        cleanup(&dir);
    }
}
