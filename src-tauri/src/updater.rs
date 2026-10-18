//! Auto-update: signed full-package updates via `tauri-plugin-updater`, a
//! `lastSeenAppVersion` marker for the post-restart changelog, and the GitHub
//! release feed that backs that changelog.
//!
//! The update prompt itself is a Vue modal in the main window (`FR-6`), so no
//! second OS window is ever created: this module only owns the state machine
//! and pushes `updater:state-changed`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

pub const STATE_EVENT: &str = "updater:state-changed";
const APP_SETTINGS_FILE: &str = "app-settings.json";
const LAST_SEEN_KEY: &str = "lastSeenAppVersion";

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(5);
const RECHECK_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);
const GITHUB_OWNER: &str = "funara";
const GITHUB_REPO: &str = "arastat";

/// Mirrors `AppUpdateState` in `src/shared/update-api.ts`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateState {
    pub status: String,
    pub current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_notes: Option<String>,
}

impl AppUpdateState {
    fn idle(version: &str) -> Self {
        Self {
            status: "idle".to_string(),
            current_version: version.to_string(),
            available_version: None,
            percent: None,
            error: None,
            release_notes: None,
        }
    }
}

/// Mirrors `ChangelogEntry` in `src/shared/update-api.ts`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogEntry {
    pub version: String,
    pub title: String,
    pub body: String,
    pub published_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html_url: Option<String>,
}

#[derive(Default)]
pub struct UpdaterState {
    state: Mutex<Option<AppUpdateState>>,
    /// The pending update handle plus its downloaded bytes (install replays them
    /// through the plugin's signature check, so they are never trusted twice).
    pending: Mutex<Option<(Update, Vec<u8>)>>,
    dismissed_version: Mutex<Option<String>>,
    changelog: Mutex<Option<Vec<ChangelogEntry>>>,
    just_updated: AtomicBool,
    started: AtomicBool,
    /// True once the updater plugin accepted a public key and endpoint.
    active: AtomicBool,
}

impl UpdaterState {
    pub fn current(&self, fallback_version: &str) -> AppUpdateState {
        let guard = lock(&self.state);
        guard
            .clone()
            .unwrap_or_else(|| AppUpdateState::idle(fallback_version))
    }

    fn set(&self, app: &AppHandle, next: AppUpdateState) {
        *lock(&self.state) = Some(next.clone());
        if let Err(err) = app.emit(STATE_EVENT, next) {
            log::debug!("[updater] state emit failed: {err}");
        }
    }

    pub fn just_updated(&self) -> bool {
        self.just_updated.load(Ordering::Relaxed)
    }

    pub fn clear_just_updated(&self) {
        self.just_updated.store(false, Ordering::Relaxed);
    }

    /// User pressed "Later": hide this build's prompt (a newer build still shows).
    pub fn dismiss(&self, app: &AppHandle) {
        let version = self
            .current(&app.package_info().version.to_string())
            .available_version;
        *lock(&self.dismissed_version) = version;
    }

    fn is_dismissed(&self, version: &Option<String>) -> bool {
        match (version, lock(&self.dismissed_version).clone()) {
            (Some(v), Some(d)) => *v == d,
            _ => false,
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn app_settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(APP_SETTINGS_FILE))
}

fn read_app_settings(path: &PathBuf) -> serde_json::Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| json!({}))
}

fn write_app_setting(path: &PathBuf, key: &str, value: serde_json::Value) {
    let mut settings = read_app_settings(path);
    if let Some(object) = settings.as_object_mut() {
        object.insert(key.to_string(), value);
    }
    if let Some(dir) = path.parent() {
        if let Err(err) = std::fs::create_dir_all(dir) {
            log::warn!("[updater] could not create {}: {err}", dir.display());
            return;
        }
    }
    // Temp file + rename so a crash mid-write cannot truncate the store.
    let tmp = path.with_extension("json.tmp");
    let serialized = serde_json::to_string_pretty(&settings).unwrap_or_else(|_| "{}".to_string());
    if let Err(err) = std::fs::write(&tmp, serialized) {
        log::warn!("[updater] could not write {}: {err}", tmp.display());
        return;
    }
    if let Err(err) = std::fs::rename(&tmp, path) {
        log::warn!("[updater] could not replace {}: {err}", path.display());
    }
}

/// Startup: decide whether the app was just updated, then arm the check timer.
pub fn init(app: &AppHandle) {
    let state = app.state::<UpdaterState>();
    if state.started.swap(true, Ordering::SeqCst) {
        return;
    }
    let version = app.package_info().version.to_string();
    state.set(app, AppUpdateState::idle(&version));

    if let Some(path) = app_settings_path(app) {
        let settings = read_app_settings(&path);
        let last_seen = settings
            .get(LAST_SEEN_KEY)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let forced = std::env::var("ARASTAT_FAKE_JUST_UPDATED").ok().as_deref() == Some("1");
        if forced || matches!(last_seen.as_deref(), Some(seen) if seen != version) {
            state.just_updated.store(true, Ordering::Relaxed);
        }
        write_app_setting(&path, LAST_SEEN_KEY, json!(version));
    }

    // A build without a configured public key or endpoint is not an updater
    // build: stay silent and make zero network requests (NFR-1).
    let configured = app
        .config()
        .plugins
        .0
        .get("updater")
        .map(|cfg| {
            let pubkey = cfg.get("pubkey").and_then(serde_json::Value::as_str).unwrap_or("");
            let has_endpoint = cfg
                .get("endpoints")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|list| !list.is_empty());
            !pubkey.trim().is_empty() && has_endpoint
        })
        .unwrap_or(false);

    if let Ok(version) = std::env::var("ARASTAT_FAKE_UPDATE") {
        if !version.trim().is_empty() {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(2)).await;
                fake_update(&app, version.trim()).await;
            });
            return;
        }
    }

    if !configured {
        log::info!("[updater] no pubkey/endpoints configured; auto-update disabled");
        return;
    }
    state.active.store(true, Ordering::SeqCst);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            check(&app).await;
            tokio::time::sleep(RECHECK_INTERVAL).await;
        }
    });
}

/// Whether an update has been announced and is ready to fetch.
pub fn has_pending(app: &AppHandle) -> bool {
    lock(&app.state::<UpdaterState>().pending).is_some()
}

/// The updater for this run.
///
/// Release builds always use the endpoint compiled into `tauri.conf.json`, so a
/// shipped binary cannot be redirected at an attacker-chosen feed. Debug builds
/// additionally honour `ARASTAT_UPDATE_ENDPOINT`, which is the only way to
/// exercise the real check/verify/download path without publishing a release
/// (Tauri itself refuses a non-HTTPS endpoint on a release build anyway).
fn build_updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let base = app.updater().map_err(|err| format!("{err}"))?;
    #[cfg(debug_assertions)]
    {
        let Ok(endpoint) = std::env::var("ARASTAT_UPDATE_ENDPOINT") else {
            return Ok(base);
        };
        if endpoint.trim().is_empty() {
            return Ok(base);
        }
        let url = url::Url::parse(endpoint.trim()).map_err(|err| format!("bad endpoint: {err}"))?;
        app
            .updater_builder()
            .endpoints(vec![url])
            .map_err(|err| format!("endpoint rejected: {err}"))?
            .build()
            .map_err(|err| format!("{err}"))
    }
    #[cfg(not(debug_assertions))]
    Ok(base)
}

/// Check the configured endpoint for a newer signed build.
pub async fn check(app: &AppHandle) {
    let state = app.state::<UpdaterState>();
    if !state.active.load(Ordering::SeqCst) {
        return;
    }
    let current = app.package_info().version.to_string();
    // Snapshot first: a recheck must never discard an update the user already has
    // (downloaded, awaiting "Restart & Install"), so a failure restores this.
    let previous = state.current(&current);
    let mut next = previous.clone();
    next.status = "checking".to_string();
    next.error = None;
    state.set(app, next);

    let updater = match build_updater(app) {
        Ok(updater) => updater,
        Err(err) => {
            skip_check(app, &previous, &err);
            return;
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let notes = update.body.clone().unwrap_or_default();
            *lock(&state.pending) = Some((update, Vec::new()));
            let mut next = state.current(&current);
            next.status = "available".to_string();
            next.available_version = Some(version.clone());
            next.percent = Some(0);
            next.release_notes = if notes.is_empty() { None } else { Some(notes) };
            state.set(app, next.clone());
            if state.is_dismissed(&next.available_version) {
                return;
            }
            // Match the old flow: fetch, then present the "Restart & Install"
            // prompt only once the package is verified on disk.
            download(app).await;
        }
        Ok(None) => {
            *lock(&state.pending) = None;
            state.set(app, AppUpdateState::idle(&current));
        }
        Err(err) => skip_check(app, &previous, &format!("{err}")),
    }
}

/// A failed *check* is not a failed update: offline, a 404 feed, or a rejected
/// endpoint means no update has been announced. Log it and restore the state from
/// before the check, so no "update failed" prompt appears and an update already
/// announced to the user stays announced. `fail()` is for download/install, where
/// an update was offered and the fetch/install itself broke.
fn skip_check(app: &AppHandle, previous: &AppUpdateState, reason: &str) {
    log::info!("[updater] check skipped/offline: {reason}");
    app.state::<UpdaterState>().set(app, previous.clone());
}

/// Fetch (and verify) the pending update, streaming progress to the modal.
pub async fn download(app: &AppHandle) {
    let state = app.state::<UpdaterState>();
    let current = app.package_info().version.to_string();
    let Some((update, existing)) = lock(&state.pending).clone() else {
        // Nothing pending yet: the command layer routes this to `check`.
        log::info!("[updater] download requested with no pending update");
        return;
    };

    if !existing.is_empty() {
        let version = update.version.clone();
        let bytes = existing;
        if update.verify(&bytes).is_ok() {
            *lock(&state.pending) = Some((update, bytes));
            let mut next = state.current(&current);
            next.status = "downloaded".to_string();
            next.available_version = Some(version);
            next.percent = Some(100);
            state.set(app, next);
            return;
        }
        log::warn!("[updater] cached package failed verification; re-downloading");
    }

    let version = update.version.clone();
    let mut next = state.current(&current);
    next.status = "downloading".to_string();
    next.available_version = Some(version.clone());
    next.percent = Some(0);
    state.set(app, next);

    let progress_app = app.clone();
    let last_percent = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(u32::MAX));
    let chunks = std::sync::Arc::new(Mutex::new(0usize));
    let chunk_app = app.clone();
    let chunk_count = std::sync::Arc::clone(&chunks);
    let on_chunk = move |chunk: usize, total: Option<u64>| {
        let mut downloaded = lock(&chunk_count);
        *downloaded += chunk;
        let percent = match total {
            Some(total) if total > 0 => ((*downloaded as u64 * 100) / total).min(100) as u32,
            _ => 0,
        };
        let state = chunk_app.state::<UpdaterState>();
        let last = last_percent.load(Ordering::Relaxed);
        if percent == last || percent == 0 {
            return;
        }
        last_percent.store(percent, Ordering::Relaxed);
        let mut next = state.current(&chunk_app.package_info().version.to_string());
        next.status = "downloading".to_string();
        next.percent = Some(percent);
        state.set(&chunk_app, next);
    };

    let result = update.download(on_chunk, || {}).await;
    let _ = progress_app;
    match result {
        Ok(bytes) => {
            *lock(&state.pending) = Some((update, bytes));
            let mut next = state.current(&current);
            next.status = "downloaded".to_string();
            next.available_version = Some(version);
            next.percent = Some(100);
            state.set(app, next);
        }
        Err(err) => fail(app, &format!("{err}")),
    }
}

/// "Restart & Install": install the verified package and relaunch.
pub fn install(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<UpdaterState>();
    let Some((update, bytes)) = lock(&state.pending).clone() else {
        return Err("No update has been downloaded yet.".to_string());
    };
    if bytes.is_empty() {
        // Dev/no-payload flow: nothing to install, just drop the prompt.
        state.set(app, AppUpdateState::idle(&app.package_info().version.to_string()));
        return Ok(());
    }
    update
        .install(bytes)
        .map_err(|err| format!("The update could not be installed: {err}"))
}

fn fail(app: &AppHandle, message: &str) {
    let state = app.state::<UpdaterState>();
    let current = app.package_info().version.to_string();
    let mut next = state.current(&current);
    next.status = "error".to_string();
    next.error = Some(message.to_string());
    next.percent = None;
    state.set(app, next);
}

/// Simulated download for UI work without a published release.
async fn fake_update(app: &AppHandle, version: &str) {
    let state = app.state::<UpdaterState>();
    let current = app.package_info().version.to_string();
    let mut next = state.current(&current);
    next.status = "downloading".to_string();
    next.available_version = Some(version.to_string());
    next.percent = Some(0);
    next.release_notes = Some(format!(
        "### What's New in v{version}\n- Auto-update flow with in-app changelog\n- Performance improvements\n- Bug fixes across modules"
    ));
    state.set(app, next);
    for step in 1..=7 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let mut next = state.current(&current);
        next.status = "downloading".to_string();
        next.percent = Some(step * 15);
        state.set(app, next);
    }
    let mut next = state.current(&current);
    next.status = "downloaded".to_string();
    next.percent = Some(100);
    state.set(app, next);
    if state.just_updated.load(Ordering::Relaxed) {
        state.clear_just_updated();
    }
}

/// Release notes for the post-restart changelog card.
pub async fn changelog(app: &AppHandle) -> Vec<ChangelogEntry> {
    let state = app.state::<UpdaterState>();
    if let Some(cached) = lock(&state.changelog).clone() {
        if !cached.is_empty() {
            return cached;
        }
    }
    let repo = std::env::var("ARASTAT_GITHUB_REPO").unwrap_or_else(|_| GITHUB_REPO.to_string());
    let url = format!("https://api.github.com/repos/{GITHUB_OWNER}/{repo}/releases?per_page=10");
    let fetched = async {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .ok()?;
        let response = client
            .get(url)
            .header("User-Agent", "ARAStat")
            .header("Accept", "application/vnd.github.v3+json")
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let releases: Vec<serde_json::Value> = response.json().await.ok()?;
        let entries: Vec<ChangelogEntry> = releases
            .iter()
            .filter(|release| !release.get("draft").and_then(serde_json::Value::as_bool).unwrap_or(false))
            .map(|release| {
                let tag = release
                    .get("tag_name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .trim_start_matches('v')
                    .to_string();
                ChangelogEntry {
                    title: release
                        .get("name")
                        .and_then(serde_json::Value::as_str)
                        .filter(|name| !name.is_empty())
                        .unwrap_or(&tag)
                        .to_string(),
                    version: tag,
                    body: release
                        .get("body")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    published_at: release
                        .get("published_at")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    html_url: release
                        .get("html_url")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string),
                }
            })
            .collect();
        (!entries.is_empty()).then_some(entries)
    }
    .await;

    if let Some(entries) = fetched {
        *lock(&state.changelog) = Some(entries.clone());
        return entries;
    }

    // Offline or no releases yet: one entry built from the running build so the
    // card never opens empty.
    let version = app.package_info().version.to_string();
    let notes = state
        .current(&version)
        .release_notes
        .unwrap_or_else(|| "- Fixes and improvements in this release.".to_string());
    vec![ChangelogEntry {
        title: format!("v{version}"),
        version,
        body: notes,
        published_at: String::new(),
        html_url: None,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dismissed_version_hides_only_that_build() {
        let state = UpdaterState::default();
        assert!(!state.is_dismissed(&Some("0.2.0".to_string())));
        *lock(&state.dismissed_version) = Some("0.2.0".to_string());
        assert!(state.is_dismissed(&Some("0.2.0".to_string())));
        assert!(!state.is_dismissed(&Some("0.3.0".to_string())));
        assert!(!state.is_dismissed(&None));
    }

    #[test]
    fn idle_state_reports_the_running_version() {
        let state = UpdaterState::default();
        let current = state.current("1.2.3");
        assert_eq!(current.status, "idle");
        assert_eq!(current.current_version, "1.2.3");
        assert!(current.available_version.is_none());
    }

    #[test]
    fn just_updated_flag_clears() {
        let state = UpdaterState::default();
        state.just_updated.store(true, Ordering::Relaxed);
        assert!(state.just_updated());
        state.clear_just_updated();
        assert!(!state.just_updated());
    }

    #[test]
    fn app_settings_round_trip_and_survive_corrupt_input() {
        let dir = std::env::temp_dir().join(format!("arastat-updater-{}", std::process::id()));
        let path = dir.join(APP_SETTINGS_FILE);
        write_app_setting(&path, LAST_SEEN_KEY, json!("0.1.0"));
        assert_eq!(read_app_settings(&path)[LAST_SEEN_KEY], json!("0.1.0"));
        std::fs::write(&path, "not json").unwrap();
        assert!(read_app_settings(&path).as_object().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
