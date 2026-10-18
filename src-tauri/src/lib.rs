//! ARAStat Tauri v2 host: window + IPC wiring, engine sidecar, AI proxy,
//! settings/keychain, and the signed updater.

mod ai;
mod commands;
mod engine;
#[cfg(windows)]
mod jobobj;
// Public so the integration tests can exercise the engine seam directly.
pub mod seam;
mod settings;
mod updater;
mod urlpolicy;

use std::sync::Mutex;
use std::time::Duration;

use tauri::{Emitter, Manager};

/// Minimal stderr logger: the host has no log plugin, and engine/setup failures
/// must be diagnosable in a terminal. Release builds have no console on Windows,
/// so this stays quiet there by construction (writes go nowhere).
struct StderrLogger;

impl log::Log for StderrLogger {
    fn enabled(&self, _metadata: &log::Metadata) -> bool {
        true
    }

    fn log(&self, record: &log::Record) {
        eprintln!("[{}] {}", record.level(), record.args());
    }

    fn flush(&self) {}
}

static LOGGER: StderrLogger = StderrLogger;

pub fn run() {
    let _ = log::set_logger(&LOGGER).map(|()| log::set_max_level(log::LevelFilter::Info));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Mutex::new(engine::EngineState::default()))
        .manage(updater::UpdaterState::default())
        .invoke_handler(tauri::generate_handler![
            commands::file_open,
            commands::file_save,
            commands::file_read_bytes,
            commands::file_write_bytes,
            commands::engine_invoke,
            commands::settings_get,
            commands::settings_set,
            commands::ai_chat,
            commands::ai_missing_advice,
            commands::ai_list_models,
            commands::window_minimize,
            commands::window_toggle_maximize,
            commands::window_is_maximized,
            commands::window_close,
            commands::updater_get_state,
            commands::updater_check,
            commands::updater_download,
            commands::updater_install,
            commands::updater_dismiss,
            commands::updater_get_changelog,
            commands::updater_get_just_updated,
            commands::updater_clear_just_updated,
            commands::open_external,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Earlier builds kept one provider-agnostic key (plaintext JSON or a
            // single keychain entry); move it to the configured provider's entry.
            if let Ok(dir) = handle.path().app_data_dir() {
                settings::migrate_legacy_keys(&dir);
            }

            engine::start(&handle);
            updater::init(&handle);

            // The window starts hidden so the WebView paints before it appears.
            if let Some(window) = app.get_webview_window("main") {
                let window = window.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    if !window.is_maximized().unwrap_or(false) {
                        if let Err(err) = window.maximize() {
                            log::warn!("[window] maximize failed: {err}");
                        }
                    }
                    if let Err(err) = window.show() {
                        log::warn!("[window] show failed: {err}");
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Frameless titlebar: keep the maximize/restore glyph in sync.
            if matches!(event, tauri::WindowEvent::Resized(_)) {
                let maximized = window.is_maximized().unwrap_or(false);
                let _ = window.emit_to(window.label(), "window:stateChanged", maximized);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building ARAStat")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                engine::stop(app);
            }
        });
}
