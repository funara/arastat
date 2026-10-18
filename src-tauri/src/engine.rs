//! `ara_engine` Python sidecar lifecycle: discovery, spawn, and the Windows
//! Job Object that guarantees the child dies with the app.
//!
//! The engine speaks NDJSON-RPC 2.0 over stdin/stdout (`seam.rs`); stderr is
//! forwarded to the log.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::seam::{SeamClient, SeamError};

/// Engine protocol notification channel (`engine.onNotification`).
pub const NOTIFICATION_EVENT: &str = "engine:notification";

#[derive(Default)]
pub struct EngineState {
    pub seam: Option<Arc<SeamClient>>,
    /// Windows only: closing this handle kills the engine process. The state
    /// lives as long as the app, so the kernel cleans up on crash or task-kill.
    #[cfg(windows)]
    pub job: Option<crate::jobobj::ProcessJob>,
}

/// Engine root: the directory holding `ara_engine/` and usually `.venv`.
///
/// Packaged installers land the bundle at `$RESOURCE/engine`; dev runs find the
/// repo by walking up out of `src-tauri/target/<profile>`. Walk the candidates
/// instead of assuming one layout (`src/main/index.ts` did the same).
pub fn engine_root(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(resource_dir) = app.path().resolve("engine", BaseDirectory::Resource) {
        candidates.push(resource_dir);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("engine"));
            candidates.push(dir.join("resources").join("engine"));
            // src-tauri/target/<profile> -> repo root
            if let Some(repo) = dir.parent().and_then(Path::parent).and_then(Path::parent) {
                candidates.push(repo.join("engine"));
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("engine"));
    }
    candidates
        .into_iter()
        .find(|dir| dir.join("ara_engine").join("__init__.py").is_file())
}

/// Interpreter for `root`: the bundled venv first, then a PATH interpreter for
/// dev runs. Only the venv is guaranteed to carry numpy/scipy.
pub fn python_for(root: &Path) -> PathBuf {
    let venv = if cfg!(windows) {
        root.join(".venv").join("Scripts").join("python.exe")
    } else {
        root.join(".venv").join("bin").join("python")
    };
    if venv.is_file() {
        return venv;
    }
    PathBuf::from(if cfg!(windows) { "python" } else { "python3" })
}

/// Spawn `python -m ara_engine` and wire its stdio to a `SeamClient`.
pub fn spawn(app: &AppHandle, root: &Path) -> Result<Spawned, String> {
    let python = python_for(root);
    let mut command = Command::new(&python);
    command
        .arg("-m")
        .arg("ara_engine")
        .current_dir(root)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // Unix teardown path: a dropped child takes the engine with it.
        .kill_on_drop(true);
    // No console window flash on Windows startup.
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let mut child = command
        .spawn()
        .map_err(|err| format!("could not start {}: {err}", python.display()))?;
    log::info!("[engine] started {} in {}", python.display(), root.display());

    #[cfg(windows)]
    let job = {
        let raw = child
            .raw_handle()
            .unwrap_or(std::ptr::null_mut());
        match crate::jobobj::ProcessJob::assign(raw) {
            Ok(job) => Some(job),
            // The engine still runs without the guard; it just loses the
            // kernel-enforced kill-on-close guarantee.
            Err(err) => {
                log::warn!("[engine] job object unavailable: {err}");
                None
            }
        }
    };

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "engine stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "engine stdout unavailable".to_string())?;

    if let Some(stderr) = child.stderr.take() {
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::warn!("[engine] {line}");
            }
        });
    }

    let handle = app.clone();
    let seam = SeamClient::new(stdin, stdout, move |note| {
        // Push-only analysis progress: no id, no reply.
        if let Err(err) = tauri::Emitter::emit(&handle, NOTIFICATION_EVENT, note) {
            log::debug!("[engine] notification emit failed: {err}");
        }
    });

    // Reap the child so a crashed engine surfaces as rejected requests rather
    // than a silent hang.
    tauri::async_runtime::spawn(async move {
        match child.wait().await {
            Ok(status) => log::info!("[engine] exited with {status}"),
            Err(err) => log::warn!("[engine] wait failed: {err}"),
        }
    });

    Ok(Spawned {
        seam,
        #[cfg(windows)]
        job,
    })
}

pub struct Spawned {
    pub seam: Arc<SeamClient>,
    #[cfg(windows)]
    pub job: Option<crate::jobobj::ProcessJob>,
}

/// The managed seam, or the "engine not running" rejection.
pub fn seam_of(app: &AppHandle) -> Result<Arc<SeamClient>, SeamError> {
    app.try_state::<std::sync::Mutex<EngineState>>()
        .and_then(|state| {
            let guard = match state.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            guard.seam.clone()
        })
        .ok_or_else(SeamError::not_running)
}

/// Start the engine once at setup; failures are logged, never fatal (the UI can
/// still open data and report the missing engine per analysis).
pub fn start(app: &AppHandle) -> Option<Arc<SeamClient>> {
    let state = app.state::<std::sync::Mutex<EngineState>>();
    let Some(root) = engine_root(app) else {
        log::error!("[engine] ara_engine not found; analyses will report no engine");
        return None;
    };
    match spawn(app, &root) {
        Ok(spawned) => {
            let mut guard = match state.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            guard.seam = Some(Arc::clone(&spawned.seam));
            #[cfg(windows)]
            {
                guard.job = spawned.job;
            }
            Some(spawned.seam)
        }
        Err(err) => {
            log::error!("[engine] {err}");
            None
        }
    }
}

/// Stop the engine cleanly: closing stdin is its documented EOF shutdown.
pub fn stop(app: &AppHandle) {
    if let Some(state) = app.try_state::<std::sync::Mutex<EngineState>>() {
        let mut guard = match state.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(seam) = guard.seam.take() {
            seam.shutdown();
        }
        #[cfg(windows)]
        {
            guard.job = None; // closes the handle: the kernel kills the child
        }
    }
}
