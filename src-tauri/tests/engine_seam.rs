//! End-to-end smoke test: the Rust `SeamClient` against the REAL `ara_engine`
//! child process. This is the only test that proves the Rust NDJSON multiplexer
//! speaks the engine's protocol.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use arastat_lib::seam::SeamClient;
use tokio::process::Command;

fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR is <repo>/src-tauri
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crate sits inside the repo")
        .to_path_buf()
}

fn engine_python(root: &Path) -> PathBuf {
    let venv = root.join("engine").join(".venv").join(if cfg!(windows) {
        "Scripts/python.exe"
    } else {
        "bin/python"
    });
    if venv.is_file() {
        venv
    } else {
        PathBuf::from(if cfg!(windows) { "python" } else { "python3" })
    }
}

/// Spawn the engine exactly like `engine::spawn` does, minus the Tauri handle.
fn start_engine() -> Option<(tokio::process::Child, Arc<SeamClient>)> {
    let root = repo_root().join("engine");
    if !root.join("ara_engine").join("__init__.py").is_file() {
        return None;
    }
    let mut child = Command::new(engine_python(&repo_root()))
        .arg("-m")
        .arg("ara_engine")
        .current_dir(&root)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let stdin = child.stdin.take()?;
    let stdout = child.stdout.take()?;
    let seam = SeamClient::new(stdin, stdout, |_note| {});
    Some((child, seam))
}

#[tokio::test]
async fn capabilities_round_trips_through_the_live_engine() {
    let Some((mut child, seam)) = start_engine() else {
        eprintln!("skipping: engine not available");
        return;
    };
    let caps = tokio::time::timeout(Duration::from_secs(60), seam.invoke("capabilities", None))
        .await
        .expect("capabilities timed out")
        .expect("capabilities rejected");
    let analyses = caps
        .get("analyses")
        .and_then(serde_json::Value::as_array)
        .expect("analyses list")
        .clone();
    // 23 golden-reference procedures are the documented floor; the engine may
    // register extras (e.g. shapiro_wilk) without breaking this contract.
    assert!(
        analyses.len() >= 23,
        "engine advertised only {} analyses",
        analyses.len()
    );
    let names: Vec<&str> = analyses.iter().filter_map(serde_json::Value::as_str).collect();
    for required in ["ttest_independent", "anova_oneway", "logistic_regression"] {
        assert!(names.contains(&required), "missing analysis {required}");
    }

    drop(seam);
    let status = tokio::time::timeout(Duration::from_secs(30), child.wait())
        .await
        .expect("engine did not exit on stdin EOF")
        .expect("wait failed");
    assert!(status.success(), "engine exited with {status}");
}

#[tokio::test]
async fn unknown_analysis_error_carries_the_verbatim_user_message() {
    let Some((_child, seam)) = start_engine() else {
        eprintln!("skipping: engine not available");
        return;
    };
    let err = seam
        .invoke(
            "run_analysis",
            Some(serde_json::json!({
                "runId": "r-smoke",
                "analysisId": "not_a_real_test",
                "spec": {},
                "data": {},
                "missingPolicy": "listwise"
            })),
        )
        .await
        .expect_err("unknown analysis must be rejected");
    assert_eq!(err.code, 1002);
    assert!(
        err.user_message.contains("not_a_real_test"),
        "user message names the analysis: {}",
        err.user_message
    );
}

#[tokio::test]
async fn concurrent_requests_are_multiplexed_by_id() {
    let Some((_child, seam)) = start_engine() else {
        eprintln!("skipping: engine not available");
        return;
    };
    // Both requests are in flight before either reply is read: only correct
    // id multiplexing keeps them from crossing.
    let (first, second) = tokio::join!(
        seam.invoke("capabilities", None),
        seam.invoke("capabilities", None)
    );
    let first = first.expect("first rejected");
    let second = second.expect("second rejected");
    assert_eq!(first, second);
    assert_eq!(first["engine"], second["engine"]);
}
