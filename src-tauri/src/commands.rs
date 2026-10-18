//! Tauri command surface. Every `#[tauri::command]` the renderer bridge calls
//! lives here, so the IPC contract is auditable in one file.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::seam::SeamError;
use crate::settings::{self, AiSettings};
use crate::{ai, engine, updater};

/// Error shape the bridge normalizes into `Error(userMessage)` with `.code`
/// and `.data` attached (`FR-1`), matching what the engine seam already sends.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CmdError {
    pub code: i64,
    pub message: String,
    pub user_message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl CmdError {
    fn new(user_message: impl Into<String>) -> Self {
        let user_message = user_message.into();
        Self {
            code: -1,
            message: user_message.clone(),
            user_message,
            detail: None,
        }
    }

    fn with_detail(user_message: impl Into<String>, detail: impl std::fmt::Display) -> Self {
        let user_message = user_message.into();
        Self {
            code: -1,
            message: user_message.clone(),
            user_message,
            detail: Some(detail.to_string()),
        }
    }
}

impl From<SeamError> for CmdError {
    fn from(err: SeamError) -> Self {
        Self {
            code: err.code,
            message: err.message,
            user_message: err.user_message,
            detail: err.detail,
        }
    }
}

impl From<ai::AiError> for CmdError {
    fn from(err: ai::AiError) -> Self {
        Self {
            code: -1,
            message: err.user_message.clone(),
            user_message: err.user_message,
            detail: None,
        }
    }
}

/// Path-conversion failures for native dialog results.
fn path_of(file: FilePath) -> Result<String, CmdError> {
    file.into_path()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|err| CmdError::with_detail("That file location could not be used. Try a different folder.", err))
}

// ---------------------------------------------------------------- files (FR-3)

/// The native picker blocks until the user answers it; it must not stall a Tokio
/// worker thread, so the builder (cheap, no window yet) is handed to the blocking
/// pool where `blocking_pick_file` can park safely.
async fn pick_file_blocking(
    builder: tauri_plugin_dialog::FileDialogBuilder<tauri::Wry>,
) -> Result<Option<String>, CmdError> {
    tokio::task::spawn_blocking(move || builder.blocking_pick_file())
        .await
        .map_err(|err| CmdError::with_detail("The file dialog could not be opened. Try again.", err))?
        .map(path_of)
        .transpose()
}

#[tauri::command]
pub async fn file_open(window: WebviewWindow) -> Result<Option<String>, CmdError> {
    let builder = window
        .dialog()
        .file()
        .add_filter("Data and project files", &["sav", "csv", "xlsx", "xls", "zip"])
        .add_filter("SPSS data", &["sav"])
        .add_filter("Comma separated values", &["csv"])
        .add_filter("Excel workbook", &["xlsx", "xls"])
        .add_filter("ARAStat project", &["zip"]);
    pick_file_blocking(builder).await
}

#[tauri::command]
pub async fn file_save(
    window: WebviewWindow,
    default_path: Option<String>,
) -> Result<Option<String>, CmdError> {
    let mut builder = window.dialog().file();
    if let Some(default_path) = default_path.as_deref() {
        builder = builder.set_file_name(default_path);
    }
    // Filters follow the requested extension: the save dialog reads it as the
    // user's intent (HTML export, raw CSV, project archive).
    let lower = default_path.as_deref().unwrap_or("").to_lowercase();
    builder = if lower.ends_with(".html") {
        builder.add_filter("HTML document", &["html"]).add_filter("All files", &["*"])
    } else if lower.ends_with(".csv") {
        builder.add_filter("Comma separated values", &["csv"]).add_filter("All files", &["*"])
    } else if lower.ends_with(".ara.zip") || lower.ends_with(".zip") {
        builder
            .add_filter("ARAStat project", &["zip"])
            .add_filter("All files", &["*"])
    } else {
        builder.add_filter("All files", &["*"])
    };
    tokio::task::spawn_blocking(move || builder.blocking_save_file())
        .await
        .map_err(|err| CmdError::with_detail("The file dialog could not be opened. Try again.", err))?
        .map(path_of)
        .transpose()
}

/// Read a file as raw bytes: `Response` hands the WebView an `ArrayBuffer`
/// with no JSON `[u8]` serialization in between.
#[tauri::command]
pub async fn file_read_bytes(path: String) -> Result<Response, CmdError> {
    let bytes = tokio::fs::read(&path).await.map_err(|err| {
        CmdError::with_detail(
            "The file could not be read. Try again, or check that the file still exists.",
            format!("{path}: {err}"),
        )
    })?;
    Ok(Response::new(bytes))
}

/// Write raw bytes: the payload is the request body, the target path rides in
/// the `x-file-path` header (Tauri cannot mix raw and JSON args in one call).
/// The header is percent-encoded so non-ASCII and spaced paths survive the trip.
#[tauri::command]
pub async fn file_write_bytes(request: Request<'_>) -> Result<bool, CmdError> {
    let encoded = header_value(request.headers(), "x-file-path")
        .ok_or_else(|| CmdError::new("The save location was missing. Try saving again."))?;
    let path = percent_decode(&encoded).ok_or_else(|| {
        CmdError::new("The save location was not a valid path. Try saving to a different folder.")
    })?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(CmdError::new("The file contents were missing. Try saving again."));
    };
    write_atomically(Path::new(&path), bytes).await?;
    Ok(true)
}

fn header_value(headers: &tauri::http::HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .filter(|value| !value.is_empty())
}

/// Reverse of JS `encodeURIComponent`: `%XX` escapes back to bytes, then UTF-8.
fn percent_decode(encoded: &str) -> Option<String> {
    let bytes = encoded.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let text = std::str::from_utf8(hex).ok()?;
            out.push(u8::from_str_radix(text, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Temp file + rename so an interrupted write cannot truncate an existing file.
async fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), CmdError> {
    let tmp = sibling_temp(path);
    tokio::fs::write(&tmp, bytes).await.map_err(|err| {
        CmdError::with_detail(
            "The file could not be saved. Try a different location.",
            format!("{}: {err}", tmp.display()),
        )
    })?;
    if let Err(err) = tokio::fs::rename(&tmp, path).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(CmdError::with_detail(
            "The file could not be saved. Try a different location.",
            format!("{}: {err}", path.display()),
        ));
    }
    Ok(())
}

fn sibling_temp(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "arastat".to_string());
    path.with_file_name(format!("{name}.arastat-tmp"))
}

// -------------------------------------------------------------- engine (FR-4)

#[tauri::command]
pub async fn engine_invoke(
    app: AppHandle,
    method: String,
    params: Option<Value>,
) -> Result<Value, CmdError> {
    let seam = engine::seam_of(&app)?;
    Ok(seam.invoke(&method, params).await?)
}

// ------------------------------------------------------------ settings (FR-5)

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, CmdError> {
    app.path().app_data_dir().map_err(|err| {
        CmdError::with_detail(
            "ARAStat could not reach its settings folder. Restart the app and try again.",
            err,
        )
    })
}

#[tauri::command]
pub async fn settings_get(app: AppHandle) -> Result<Value, CmdError> {
    let dir = app_data_dir(&app)?;
    let settings = settings::load_settings(&dir);
    Ok(settings::renderer_view(&settings))
}

#[tauri::command]
pub async fn settings_set(app: AppHandle, patch: Value) -> Result<Value, CmdError> {
    let dir = app_data_dir(&app)?;
    let saved = settings::save_settings(&dir, &patch).map_err(CmdError::new)?;
    Ok(settings::renderer_view(&saved))
}

// ------------------------------------------------------------------ ai (FR-5)

async fn ai_settings(app: &AppHandle) -> Result<AiSettings, CmdError> {
    Ok(settings::load_settings(&app_data_dir(app)?))
}

#[tauri::command]
pub async fn ai_chat(app: AppHandle, messages: Value) -> Result<String, CmdError> {
    let settings = ai_settings(&app).await?;
    Ok(ai::chat(&settings, &messages).await?)
}

/// Never rejects: a provider failure resolves to the deterministic offline rule
/// so the caller needs no error branch (`FR-5`).
#[tauri::command]
pub async fn ai_missing_advice(app: AppHandle, payload: Option<Value>) -> Result<String, CmdError> {
    let summary = payload
        .as_ref()
        .and_then(|value| value.get("summary"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("Missing values were found in the dataset.")
        .to_string();

    let messages = json!([
        {
            "role": "system",
            "content": "You are ARA Assistant in ARAStat. Recommend exactly one missing-value handling: listwise, pairwise, or fill (mean/median/mode). One short paragraph, no filler. Tier2 narrative only: never decide handling, only explain the aggregate profile. In prose, name grid positions as rows and columns, never cases or variables."
        },
        { "role": "user", "content": summary }
    ]);

    match ai_settings(&app).await {
        Ok(settings) => match ai::chat(&settings, &messages).await {
            Ok(advice) => Ok(advice),
            Err(err) => {
                log::info!("[ai] missing advice fell back offline: {}", err.user_message);
                Ok(ai::fallback_advice("missing values"))
            }
        },
        Err(err) => {
            log::info!("[ai] settings unavailable: {}", err.user_message);
            Ok(ai::fallback_advice("missing values"))
        }
    }
}

#[tauri::command]
pub async fn ai_list_models(app: AppHandle, payload: Option<Value>) -> Result<Vec<String>, CmdError> {
    let settings = ai_settings(&app).await?;
    let typed = payload
        .as_ref()
        .and_then(|value| value.get("baseUrl"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|url| !url.trim().is_empty());
    let panel_key = payload
        .as_ref()
        .and_then(|value| value.get("key"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|key| !key.trim().is_empty());

    let base_url = typed.unwrap_or_else(|| {
        if settings.base_url.trim().is_empty() {
            settings::CUSTOM_DEFAULT_BASE_URL.to_string()
        } else {
            settings.base_url.clone()
        }
    });
    Ok(ai::list_models(&base_url, Some(&settings.key), panel_key.as_deref()).await?)
}

// ------------------------------------------------------------- window (FR-2)

#[tauri::command]
pub fn window_minimize(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|err| err.to_string())
}

#[tauri::command]
pub fn window_toggle_maximize(window: WebviewWindow) -> Result<(), String> {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize()
    } else {
        window.maximize()
    }
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn window_is_maximized(window: WebviewWindow) -> Result<bool, String> {
    window.is_maximized().map_err(|err| err.to_string())
}

#[tauri::command]
pub fn window_close(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|err| err.to_string())
}

// ------------------------------------------------------------- updater (FR-6)

#[tauri::command]
pub fn updater_get_state(app: AppHandle) -> Value {
    let state = app.state::<updater::UpdaterState>();
    serde_json::to_value(state.current(&app.package_info().version.to_string()))
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn updater_check(app: AppHandle) -> Result<(), ()> {
    updater::check(&app).await;
    Ok(())
}

#[tauri::command]
pub async fn updater_download(app: AppHandle) -> Result<(), ()> {
    // A manual "Download" click on a prompt that has not fetched yet re-checks
    // instead; the check path itself calls `download` once a build is announced.
    if updater::has_pending(&app) {
        updater::download(&app).await;
    } else {
        updater::check(&app).await;
    }
    Ok(())
}

#[tauri::command]
pub fn updater_install(app: AppHandle) -> Result<(), String> {
    updater::install(&app)
}

#[tauri::command]
pub fn updater_dismiss(app: AppHandle) {
    app.state::<updater::UpdaterState>().dismiss(&app);
}

#[tauri::command]
pub async fn updater_get_changelog(app: AppHandle) -> Result<Vec<updater::ChangelogEntry>, ()> {
    Ok(updater::changelog(&app).await)
}

#[tauri::command]
pub fn updater_get_just_updated(app: AppHandle) -> bool {
    app.state::<updater::UpdaterState>().just_updated()
}

#[tauri::command]
pub fn updater_clear_just_updated(app: AppHandle) {
    app.state::<updater::UpdaterState>().clear_just_updated();
}

// ------------------------------------------------------------------ misc (FR-5)

/// External links open in the OS browser instead of navigating the app WebView.
#[tauri::command]
pub async fn open_external(app: AppHandle, url: String) -> Result<(), CmdError> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(CmdError::new("Only web links can be opened."));
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|err| CmdError::with_detail("That link could not be opened in your browser.", err))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_sibling_keeps_the_extension_for_the_editor() {
        assert_eq!(
            sibling_temp(Path::new("C:/data/analysis.ara.zip")),
            PathBuf::from("C:/data/analysis.ara.zip.arastat-tmp")
        );
    }

    #[test]
    fn percent_decode_round_trips_encoded_paths() {
        // Mirrors JS encodeURIComponent for a spaced, non-ASCII Windows path.
        let encoded = "C%3A%5CUsers%5Cadhir%5CMy%20Documents%5C%C3%A9tude.ara.zip";
        assert_eq!(
            percent_decode(encoded).unwrap(),
            "C:\\Users\\adhir\\My Documents\\étude.ara.zip"
        );
        // Unescaped input passes through unchanged.
        assert_eq!(
            percent_decode("C:\\plain\\file.csv").unwrap(),
            "C:\\plain\\file.csv"
        );
        // Truncated escape and invalid UTF-8 are rejected, never guessed.
        assert!(percent_decode("C:\\bad%2").is_none());
        assert!(percent_decode("C:\\bad%FF%FE").is_none());
    }

    #[test]
    fn command_errors_carry_the_user_copy() {
        let err: CmdError = SeamError {
            code: 1004,
            message: "analysis failed".to_string(),
            user_message: "A three-level grouping variable is refused.".to_string(),
            detail: Some("levels=3".to_string()),
        }
        .into();
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], 1004);
        assert_eq!(json["userMessage"], "A three-level grouping variable is refused.");
        assert_eq!(json["detail"], "levels=3");
    }

    #[test]
    fn ai_errors_map_to_a_single_user_message() {
        let err: CmdError = ai::AiError::with(
            ai::AiErrorKind::Network,
            None,
            "The AI service is unreachable.",
        )
        .into();
        assert_eq!(err.user_message, "The AI service is unreachable.");
        assert!(err.detail.is_none());
    }
}
