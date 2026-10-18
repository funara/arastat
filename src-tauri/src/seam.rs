//! NDJSON-RPC 2.0 client over the `ara_engine` child process's stdio.
//!
//! One request per line, one response per line, with out-of-band
//! `analysis/update` and `analysis/done` notifications pushed to the WebView.
//! Requests are multiplexed by JSON-RPC id so callers can await concurrently.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdout;
use tokio::sync::{oneshot, Mutex as AsyncMutex};

/// JSON-RPC 2.0 error object as the renderer sees it (`runAnalysis.ts` reads
/// `data.userMessage` verbatim, falling back to `message`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeamError {
    pub code: i64,
    pub message: String,
    pub user_message: String,
    pub detail: Option<String>,
}

impl SeamError {
    fn from_json(err: &Value) -> Self {
        let code = err.get("code").and_then(Value::as_i64).unwrap_or(-1);
        let message = err
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("engine error")
            .to_string();
        let data = err.get("data").and_then(Value::as_object);
        let user_message = data
            .and_then(|d| d.get("userMessage"))
            .and_then(Value::as_str)
            .unwrap_or(&message)
            .to_string();
        let detail = data
            .and_then(|d| d.get("detail"))
            .and_then(Value::as_str)
            .map(str::to_string);
        Self {
            code,
            message,
            user_message,
            detail,
        }
    }

    /// The engine's stdout closed: no request can be answered any more.
    pub fn stream_closed() -> Self {
        Self {
            code: -1,
            message: "engine stream closed".to_string(),
            user_message:
                "The statistics engine stopped unexpectedly. Restart ARAStat and run the analysis again."
                    .to_string(),
            detail: None,
        }
    }

    /// No engine process was ever started (missing bundle or spawn failure).
    pub fn not_running() -> Self {
        Self {
            code: -1,
            message: "engine not running".to_string(),
            user_message: "The statistics engine is not running. Restart ARAStat and run the analysis again."
                .to_string(),
            detail: None,
        }
    }
}

/// Engine push message: no JSON-RPC id, just method + params.
#[derive(Debug, Clone, Serialize)]
pub struct SeamNotification {
    pub method: String,
    pub params: Value,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, SeamError>>>>>;

pub struct SeamClient {
    stdin: AsyncMutex<tokio::process::ChildStdin>,
    pending: Pending,
    next_id: AtomicU64,
}

/// `Mutex::lock` without the poisoning panic: a panicked reader must not take
/// the whole engine seam down with it.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

impl SeamClient {
    pub fn new(
        stdin: tokio::process::ChildStdin,
        stdout: ChildStdout,
        on_notification: impl Fn(SeamNotification) + Send + 'static,
    ) -> Arc<Self> {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let client = Arc::new(Self {
            stdin: AsyncMutex::new(stdin),
            pending: Arc::clone(&pending),
            next_id: AtomicU64::new(1),
        });

        let reader_pending = Arc::clone(&pending);
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            // EOF or read error ends the loop: the child is gone.
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                let msg: Value = match serde_json::from_str(&line) {
                    Ok(value) => value,
                    Err(err) => {
                        log::warn!("[engine] unparseable stdout line: {err}");
                        continue;
                    }
                };
                dispatch(&msg, &reader_pending, &on_notification);
            }
            reject_all(&reader_pending, SeamError::stream_closed());
        });

        client
    }

    /// Send one request; resolves with `result` or rejects with a `SeamError`.
    pub async fn invoke(&self, method: &str, params: Option<Value>) -> Result<Value, SeamError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        lock(&self.pending).insert(id, tx);

        let mut line = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params.unwrap_or(Value::Null),
        })
        .to_string();
        line.push('\n');

        let write_result = {
            let mut stdin = self.stdin.lock().await;
            stdin.write_all(line.as_bytes()).await
        };
        if let Err(err) = write_result {
            lock(&self.pending).remove(&id);
            return Err(SeamError {
                code: -1,
                message: format!("engine write failed: {err}"),
                user_message:
                    "The statistics engine stopped unexpectedly. Restart ARAStat and run the analysis again."
                        .to_string(),
                detail: Some(err.to_string()),
            });
        }

        rx.await.unwrap_or_else(|_| Err(SeamError::stream_closed()))
    }

    /// Reject every in-flight request (engine teardown).
    pub fn shutdown(&self) {
        reject_all(&self.pending, SeamError::stream_closed());
    }
}

fn dispatch(
    msg: &Value,
    pending: &Pending,
    on_notification: &(impl Fn(SeamNotification) + Send + 'static),
) {
    if let Some(method) = msg.get("method").and_then(Value::as_str) {
        on_notification(SeamNotification {
            method: method.to_string(),
            params: msg.get("params").cloned().unwrap_or(Value::Null),
        });
        return;
    }
    let Some(id) = msg.get("id").and_then(Value::as_u64) else {
        return;
    };
    let Some(sender) = lock(pending).remove(&id) else {
        return;
    };
    let outcome = match msg.get("error") {
        Some(err) if !err.is_null() => Err(SeamError::from_json(err)),
        _ => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
    };
    let _ = sender.send(outcome);
}

fn reject_all(pending: &Pending, error: SeamError) {
    let drained: Vec<_> = match pending.lock() {
        Ok(mut guard) => guard.drain().map(|(_, sender)| sender).collect(),
        Err(poisoned) => poisoned
            .into_inner()
            .drain()
            .map(|(_, sender)| sender)
            .collect(),
    };
    for sender in drained {
        let _ = sender.send(Err(error.clone()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_json_maps_to_user_facing_fields() {
        let raw = json!({
            "code": 1004,
            "message": "analysis failed",
            "data": { "userMessage": "A three-level grouping variable is refused.", "detail": "levels=3" }
        });
        let err = SeamError::from_json(&raw);
        assert_eq!(err.code, 1004);
        assert_eq!(err.message, "analysis failed");
        assert_eq!(err.user_message, "A three-level grouping variable is refused.");
        assert_eq!(err.detail.as_deref(), Some("levels=3"));
    }

    #[test]
    fn error_without_data_falls_back_to_message() {
        let err = SeamError::from_json(&json!({ "code": -32700, "message": "parse error" }));
        assert_eq!(err.code, -32700);
        assert_eq!(err.user_message, "parse error");
        assert!(err.detail.is_none());
    }

    #[test]
    fn notifications_are_distinguished_from_responses() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let note = json!({ "method": "analysis/update", "params": { "runId": "r1" } });
        dispatch(&note, &pending, &move |n: SeamNotification| {
            lock(&sink).push(n.method);
        });
        assert_eq!(lock(&seen).as_slice(), ["analysis/update".to_string()]);
        assert!(lock(&pending).is_empty());
    }

    #[test]
    fn responses_resolve_their_oneshot_and_rejection_drains_pending() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let noop = |_n: SeamNotification| {};
        let (tx, mut rx) = oneshot::channel();
        lock(&pending).insert(7, tx);
        dispatch(
            &json!({ "id": 7, "result": { "ok": true } }),
            &pending,
            &noop,
        );
        assert_eq!(rx.try_recv().unwrap().unwrap(), json!({ "ok": true }));
        assert!(lock(&pending).is_empty());

        let (tx2, mut rx2) = oneshot::channel();
        lock(&pending).insert(9, tx2);
        reject_all(&pending, SeamError::stream_closed());
        assert_eq!(rx2.try_recv().unwrap().unwrap_err().code, -1);
        assert!(lock(&pending).is_empty());
    }

    #[test]
    fn unknown_ids_are_ignored() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let noop = |_n: SeamNotification| {};
        dispatch(&json!({ "id": 404, "result": 1 }), &pending, &noop);
        assert!(lock(&pending).is_empty());
    }
}
