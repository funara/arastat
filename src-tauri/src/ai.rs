//! Provider-agnostic AI client: Google Gemini `generateContent` or an
//! OpenAI-compatible `/chat/completions` endpoint.
//!
//! Ported from `src/main/modelCall.ts` and `src/main/ai.ts`. User-facing copy is
//! verbatim from those sources. The API key is used here only and is never
//! logged.

use std::sync::LazyLock;
use std::time::Duration;

use serde_json::{json, Value};

use crate::settings::{effective_settings, AiSettings, GOOGLE_DEFAULT_MODEL};
use crate::urlpolicy::{endpoint_for, is_localhost, models_endpoint_for};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const MODELS_TIMEOUT: Duration = Duration::from_secs(15);
const MODELS_RETRY_TIMEOUT: Duration = Duration::from_secs(10);

const GOOGLE_ENDPOINT: &str = "https://generativelanguage.googleapis.com/v1beta/models";

// Internal messages mirror `ModelCallError.message`; `chat` maps them onto the
// user copy that `src/main/ai.ts` produces.
const NO_API_KEY: &str = "No API key is set.";
const UNREACHABLE_SHORT: &str = "The AI service is unreachable.";
const INVALID_JSON: &str = "The AI service returned invalid JSON.";
const INVALID_SSE_JSON: &str = "The AI service returned invalid SSE JSON.";
const UNREADABLE_SHORT: &str = "The AI service returned an unreadable reply.";
const EMPTY_SHORT: &str = "The AI service returned an empty reply.";

// Verbatim user copy (`src/main/ai.ts`).
const NO_API_KEY_COPY: &str =
    "No API key is set. Open AI Settings and configure your Google or Custom API key to enable chat.";
const INVALID_URL_COPY: &str = "The AI provider URL is invalid. Use a public HTTPS or local OpenAI-compatible endpoint without credentials, query strings, or fragments.";
const KEY_REJECTED_COPY: &str =
    "The AI service rejected the API key. Check your API key in AI Settings.";
const RATE_LIMITED_COPY: &str = "The AI service is rate limited. Wait a moment and try again.";
const UNAVAILABLE_COPY: &str = "The AI service is temporarily unavailable. Try again later.";
const INVALID_MESSAGES_COPY: &str = "The AI request contained invalid messages. Try again.";
const UNREACHABLE_COPY: &str =
    "The AI service is unreachable. Check your network connection and base URL in AI Settings.";
const EMPTY_REPLY_COPY: &str = "The AI service returned an empty reply. Try again.";
const UNREADABLE_REPLY_COPY: &str = "The AI service returned an unreadable reply. Try again.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AiErrorKind {
    Configuration,
    Validation,
    Network,
    Response,
    Parse,
}

#[derive(Debug, serde::Serialize)]
pub struct AiError {
    pub kind: AiErrorKind,
    pub status: Option<u16>,
    pub user_message: String,
}

impl std::fmt::Display for AiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.user_message)
    }
}

impl std::error::Error for AiError {}

impl AiError {
    pub fn with(kind: AiErrorKind, status: Option<u16>, user_message: impl Into<String>) -> Self {
        Self {
            kind,
            status,
            user_message: user_message.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(reqwest::Client::new);

fn client() -> &'static reqwest::Client {
    &CLIENT
}

fn network_error() -> AiError {
    AiError::with(AiErrorKind::Network, None, UNREACHABLE_SHORT)
}

fn status_error(status: u16) -> AiError {
    AiError::with(
        AiErrorKind::Response,
        Some(status),
        format!("The AI service returned status {status}."),
    )
}

fn empty_error() -> AiError {
    AiError::with(AiErrorKind::Response, None, EMPTY_SHORT)
}

/// One completion against the configured provider ('google' or 'custom').
pub async fn chat(settings: &AiSettings, messages: &Value) -> Result<String, AiError> {
    let effective = effective_settings(settings);
    dispatch(&effective, messages)
        .await
        .map_err(to_user_copy)
}

async fn dispatch(effective: &AiSettings, messages: &Value) -> Result<String, AiError> {
    // The saved provider is authoritative: a leftover key whose prefix looks like a
    // Google credential must never redirect a Custom/local request to Google Cloud.
    if effective.provider == "google" {
        if effective.key.is_empty() {
            return Err(AiError::with(AiErrorKind::Configuration, None, NO_API_KEY));
        }
        return call_google(&effective.key, &effective.model, messages).await;
    }

    let endpoint = endpoint_for(&effective.base_url)
        .map_err(|message| AiError::with(AiErrorKind::Configuration, None, message))?;
    // Plain-HTTP endpoints are local-only (the URL policy rejected public ones),
    // so a key is optional whenever the request stays off the public internet.
    let key_optional = endpoint.starts_with("http://") || is_localhost(&url_host(&endpoint));
    if effective.key.is_empty() && !key_optional {
        return Err(AiError::with(AiErrorKind::Configuration, None, NO_API_KEY));
    }

    let normalized = normalize_messages(messages)?;
    let body = openai_request_body(&effective.model, &normalized);
    let mut request = client()
        .post(&endpoint)
        .timeout(REQUEST_TIMEOUT)
        .json(&body);
    if !effective.key.is_empty() {
        request = request.bearer_auth(&effective.key);
    }
    let response = request.send().await.map_err(|_| network_error())?;
    if !response.status().is_success() {
        return Err(status_error(response.status().as_u16()));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let raw = response
        .text()
        .await
        .map_err(|_| AiError::with(AiErrorKind::Response, None, UNREADABLE_SHORT))?;
    parse_model_response(&raw, &content_type)
}

/// Google AI Studio `generateContent` call for Google keys.
async fn call_google(key: &str, model: &str, messages: &Value) -> Result<String, AiError> {
    let normalized = normalize_messages(messages)?;
    let name = {
        let trimmed = model.trim();
        if trimmed.is_empty() {
            GOOGLE_DEFAULT_MODEL
        } else {
            trimmed
        }
    };
    let encoded: String = url::form_urlencoded::byte_serialize(name.as_bytes()).collect();
    let endpoint = format!("{GOOGLE_ENDPOINT}/{encoded}:generateContent");
    let response = client()
        .post(&endpoint)
        .timeout(REQUEST_TIMEOUT)
        .header("x-goog-api-key", key.trim())
        .json(&google_request_body(&normalized))
        .send()
        .await
        .map_err(|_| network_error())?;
    if !response.status().is_success() {
        return Err(status_error(response.status().as_u16()));
    }
    let body: Value = response.json().await.map_err(|_| {
        AiError::with(AiErrorKind::Response, None, UNREADABLE_SHORT)
    })?;
    let content = parse_google_response(&body);
    if content.is_empty() {
        return Err(empty_error());
    }
    Ok(content)
}

/// OpenAI-compatible model list, with the `/v1/models` retry on 404.
pub async fn list_models(
    base_url: &str,
    key: Option<&str>,
    panel_key: Option<&str>,
) -> Result<Vec<String>, AiError> {
    let endpoint = models_endpoint_for(base_url)
        .map_err(|message| AiError::with(AiErrorKind::Configuration, None, message))?;
    let effective_key = match panel_key {
        Some(typed) if !typed.is_empty() => Some(typed),
        _ => key,
    };
    let bearer = effective_key.map(str::trim).filter(|value| !value.is_empty());

    let mut response = models_get(&endpoint, bearer, MODELS_TIMEOUT)
        .await
        .map_err(|_| network_error())?;
    if response.status().as_u16() == 404 && !endpoint.contains("/v1/") {
        if let Some(prefix) = endpoint.strip_suffix("/models") {
            let retry_endpoint = format!("{prefix}/v1/models");
            if let Ok(retry) = models_get(&retry_endpoint, bearer, MODELS_RETRY_TIMEOUT).await {
                if retry.status().is_success() {
                    response = retry;
                }
            }
        }
    }
    if !response.status().is_success() {
        return Err(status_error(response.status().as_u16()));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|_| AiError::with(AiErrorKind::Parse, None, INVALID_JSON))?;
    Ok(parse_models_list(&body))
}

async fn models_get(
    endpoint: &str,
    bearer: Option<&str>,
    timeout: Duration,
) -> Result<reqwest::Response, reqwest::Error> {
    let request = client()
        .get(endpoint)
        .timeout(timeout)
        .header(reqwest::header::ACCEPT, "application/json");
    let request = match bearer {
        Some(key) => request.bearer_auth(key),
        None => request,
    };
    request.send().await
}

/// Map provider failures onto the same user copy `src/main/ai.ts` produces.
fn to_user_copy(error: AiError) -> AiError {
    let user_message = if error.user_message == NO_API_KEY {
        NO_API_KEY_COPY
    } else if error.kind == AiErrorKind::Configuration {
        INVALID_URL_COPY
    } else if matches!(error.status, Some(401 | 403)) {
        KEY_REJECTED_COPY
    } else if error.status == Some(429) {
        RATE_LIMITED_COPY
    } else if matches!(error.status, Some(status) if (500..600).contains(&status)) {
        UNAVAILABLE_COPY
    } else if error.kind == AiErrorKind::Validation {
        INVALID_MESSAGES_COPY
    } else if error.kind == AiErrorKind::Network {
        UNREACHABLE_COPY
    } else if error.user_message.contains("empty reply") {
        EMPTY_REPLY_COPY
    } else {
        UNREADABLE_REPLY_COPY
    };
    AiError {
        kind: error.kind,
        status: error.status,
        user_message: user_message.to_owned(),
    }
}

fn url_host(endpoint: &str) -> String {
    url::Url::parse(endpoint)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_owned))
        .unwrap_or_default()
}

/// Validate and strip unknown fields (reasoning/tool calls are never forwarded).
pub fn normalize_messages(messages: &Value) -> Result<Vec<ChatMessage>, AiError> {
    let array = messages.as_array().ok_or_else(|| {
        AiError::with(
            AiErrorKind::Validation,
            None,
            "The AI request messages must be an array.",
        )
    })?;
    let mut normalized = Vec::with_capacity(array.len());
    for (index, message) in array.iter().enumerate() {
        if !message.is_object() {
            return Err(AiError::with(
                AiErrorKind::Validation,
                None,
                format!("The AI request message at index {index} is invalid."),
            ));
        }
        let role = message.get("role").and_then(Value::as_str);
        let content = message.get("content").and_then(Value::as_str);
        match (role, content) {
            (Some(role @ ("system" | "user" | "assistant")), Some(content)) => {
                normalized.push(ChatMessage {
                    role: role.to_owned(),
                    content: content.to_owned(),
                });
            }
            _ => {
                return Err(AiError::with(
                    AiErrorKind::Validation,
                    None,
                    format!(
                        "The AI request message at index {index} must contain a supported role and string content."
                    ),
                ));
            }
        }
    }
    Ok(normalized)
}

/// Parse OpenAI-compatible SSE deltas, while accepting a normal JSON response.
pub fn parse_model_response(raw: &str, content_type: &str) -> Result<String, AiError> {
    if raw.trim().is_empty() {
        return Err(empty_error());
    }
    let streaming = content_type.to_ascii_lowercase().contains("text/event-stream")
        || raw
            .lines()
            .any(|line| line.trim_start().starts_with("data:"));
    if !streaming {
        let body: Value = serde_json::from_str(raw)
            .map_err(|_| AiError::with(AiErrorKind::Parse, None, INVALID_JSON))?;
        return finish(choices_content(&body));
    }

    let mut content = String::new();
    let mut data_lines: Vec<String> = Vec::new();
    for line in raw.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            consume_event(&mut data_lines, &mut content)?;
        } else if let Some(data) = line.strip_prefix("data:") {
            data_lines.push(data.strip_prefix(' ').unwrap_or(data).to_owned());
        }
    }
    if !data_lines.is_empty() {
        consume_event(&mut data_lines, &mut content)?;
    }
    finish(content)
}

fn finish(content: String) -> Result<String, AiError> {
    if content.trim().is_empty() {
        return Err(empty_error());
    }
    Ok(content)
}

fn consume_event(data_lines: &mut Vec<String>, content: &mut String) -> Result<(), AiError> {
    let data = data_lines.join("\n").trim().to_owned();
    data_lines.clear();
    if data.is_empty() || data == "[DONE]" {
        return Ok(());
    }
    let event: Value = serde_json::from_str(&data)
        .map_err(|_| AiError::with(AiErrorKind::Parse, None, INVALID_SSE_JSON))?;
    content.push_str(&choices_content(&event));
    Ok(())
}

fn choices_content(body: &Value) -> String {
    match body.get("choices").and_then(Value::as_array) {
        Some(choices) => choices
            .iter()
            .map(content_from_choice)
            .collect::<Vec<String>>()
            .join(""),
        None => String::new(),
    }
}

fn content_from_choice(choice: &Value) -> String {
    let delta = non_empty_string(choice.get("delta").and_then(|delta| delta.get("content")));
    if !delta.is_empty() {
        return delta;
    }
    let message =
        non_empty_string(choice.get("message").and_then(|message| message.get("content")));
    if !message.is_empty() {
        return message;
    }
    non_empty_string(choice.get("text"))
}

fn non_empty_string(value: Option<&Value>) -> String {
    match value.and_then(Value::as_str) {
        Some(text) if !text.is_empty() => text.to_owned(),
        _ => String::new(),
    }
}

pub fn parse_models_list(data: &Value) -> Vec<String> {
    let items = if let Some(items) = data.as_array() {
        items
    } else if let Some(items) = data.get("data").and_then(Value::as_array) {
        items
    } else if let Some(items) = data.get("models").and_then(Value::as_array) {
        items
    } else {
        return Vec::new();
    };

    let mut result: Vec<String> = Vec::new();
    for item in items {
        let id = if let Some(text) = item.as_str() {
            text.trim()
        } else if let Some(id) = item.get("id").and_then(Value::as_str) {
            id.trim()
        } else if let Some(name) = item.get("name").and_then(Value::as_str) {
            name.trim()
        } else {
            ""
        };
        if !id.is_empty() && !result.iter().any(|existing| existing == id) {
            result.push(id.to_owned());
        }
    }
    result
}

pub fn openai_request_body(model: &str, messages: &[ChatMessage]) -> Value {
    json!({
        "model": model,
        "messages": messages,
        "temperature": 0.7,
        "max_tokens": 2048,
        "stream": true,
    })
}

pub fn google_request_body(messages: &[ChatMessage]) -> Value {
    let mut contents: Vec<Value> = messages
        .iter()
        .filter(|message| message.role != "system")
        .map(|message| {
            let role = if message.role == "assistant" {
                "model"
            } else {
                "user"
            };
            json!({ "role": role, "parts": [{ "text": message.content }] })
        })
        .collect();
    if contents.is_empty() {
        contents.push(json!({ "role": "user", "parts": [{ "text": "Hello" }] }));
    }

    let mut body = serde_json::Map::new();
    if let Some(system) = messages.iter().find(|message| message.role == "system") {
        body.insert(
            "systemInstruction".to_owned(),
            json!({ "parts": [{ "text": system.content }] }),
        );
    }
    body.insert("contents".to_owned(), Value::Array(contents));
    body.insert(
        "generationConfig".to_owned(),
        json!({ "temperature": 0.7, "maxOutputTokens": 2048 }),
    );
    Value::Object(body)
}

pub fn parse_google_response(body: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(candidates) = body.get("candidates").and_then(Value::as_array) {
        for candidate in candidates {
            if let Some(candidate_parts) = candidate
                .get("content")
                .and_then(|content| content.get("parts"))
                .and_then(Value::as_array)
            {
                for part in candidate_parts {
                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                        parts.push(text.to_owned());
                    }
                }
            }
        }
    }
    parts.join("").trim().to_owned()
}

/// Deterministic advisory fallback for provider errors (verbatim from
/// `src/main/aiResponse.ts`).
pub fn fallback_advice(what: &str) -> String {
    format!(
        "The AI service is temporarily unavailable, so here is the offline rule for {what}: \
with no missing values keep listwise handling; with a few incomplete rows drop them; \
with widespread missingness fill numeric columns (mean/median) or categorical columns (mode) \
from the Transform menu, then rerun."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(role: &str, content: &str) -> ChatMessage {
        ChatMessage {
            role: role.to_owned(),
            content: content.to_owned(),
        }
    }

    #[test]
    fn sse_deltas_join_until_done() {
        let raw = [
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}",
            "",
            "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}",
            "",
            "data: [DONE]",
            "",
        ]
        .join("\n");
        assert_eq!(parse_model_response(&raw, "text/event-stream").unwrap(), "Hello");
    }

    #[test]
    fn plain_json_message_content_is_returned() {
        let raw = r#"{"choices":[{"message":{"content":"hi"}}]}"#;
        assert_eq!(parse_model_response(raw, "application/json").unwrap(), "hi");
        assert_eq!(parse_model_response(raw, "").unwrap(), "hi");
    }

    #[test]
    fn empty_bodies_are_an_empty_reply_error() {
        // The parse layer reports the raw copy; `chat` maps it to the
        // "Try again." guidance the renderer shows.
        for raw in ["", "   ", "\n\t"] {
            let error = parse_model_response(raw, "application/json").unwrap_err();
            assert_eq!(error.kind, AiErrorKind::Response);
            assert_eq!(error.user_message, EMPTY_SHORT);
            assert_eq!(to_user_copy(error).user_message, EMPTY_REPLY_COPY);
        }
        let error = parse_model_response(r#"{"choices":[]}"#, "application/json").unwrap_err();
        assert_eq!(error.kind, AiErrorKind::Response);
        assert_eq!(error.user_message, EMPTY_SHORT);
    }

    #[test]
    fn invalid_json_is_a_parse_error() {
        let error = parse_model_response("{not json", "application/json").unwrap_err();
        assert_eq!(error.kind, AiErrorKind::Parse);
    }

    #[test]
    fn normalize_messages_validates_shape_and_role() {
        let error = normalize_messages(&json!("not-an-array")).unwrap_err();
        assert_eq!(error.kind, AiErrorKind::Validation);
        let error = normalize_messages(&json!({ "role": "user", "content": "hi" })).unwrap_err();
        assert_eq!(error.kind, AiErrorKind::Validation);

        let error = normalize_messages(&json!([{ "role": "tool", "content": "hi" }])).unwrap_err();
        assert_eq!(error.kind, AiErrorKind::Validation);
        assert!(error.user_message.contains("index 0"));

        let error = normalize_messages(&json!([{ "role": "user", "content": 7 }])).unwrap_err();
        assert_eq!(error.kind, AiErrorKind::Validation);

        let normalized = normalize_messages(&json!([
            { "role": "system", "content": "be nice" },
            { "role": "user", "content": "hi", "reasoning_content": "dropped" },
            { "role": "assistant", "content": "hello" },
        ]))
        .unwrap();
        assert_eq!(
            normalized,
            vec![
                message("system", "be nice"),
                message("user", "hi"),
                message("assistant", "hello"),
            ]
        );
    }

    #[test]
    fn parse_models_list_handles_all_shapes_and_dedupes() {
        assert_eq!(
            parse_models_list(&json!({ "data": [{ "id": "a" }] })),
            vec!["a".to_owned()]
        );
        assert_eq!(
            parse_models_list(&json!({ "models": [{ "name": "b" }] })),
            vec!["b".to_owned()]
        );
        assert_eq!(
            parse_models_list(&json!(["c"])),
            vec!["c".to_owned()]
        );
        assert_eq!(
            parse_models_list(&json!({ "data": [{ "id": "a" }, { "id": "a" }, "a", { "id": "d" }, { "name": "e" }] })),
            vec!["a".to_owned(), "d".to_owned(), "e".to_owned()]
        );
        assert!(parse_models_list(&json!({ "object": "list" })).is_empty());
    }

    #[test]
    fn openai_request_body_carries_model_stream_and_messages() {
        let body = openai_request_body("m", &[message("user", "Hi")]);
        assert_eq!(body["model"], json!("m"));
        assert_eq!(body["stream"], json!(true));
        assert_eq!(body["temperature"], json!(0.7));
        assert_eq!(body["max_tokens"], json!(2048));
        assert_eq!(body["messages"], json!([{ "role": "user", "content": "Hi" }]));
    }

    #[test]
    fn google_request_body_moves_system_and_renames_assistant() {
        let body = google_request_body(&[
            message("system", "You are ARA Assistant."),
            message("user", "What is a p-value?"),
            message("assistant", "A probability."),
        ]);
        assert_eq!(
            body["systemInstruction"]["parts"][0]["text"],
            json!("You are ARA Assistant.")
        );
        assert_eq!(
            body["contents"],
            json!([
                { "role": "user", "parts": [{ "text": "What is a p-value?" }] },
                { "role": "model", "parts": [{ "text": "A probability." }] },
            ])
        );
        assert_eq!(body["generationConfig"]["maxOutputTokens"], json!(2048));

        let empty = google_request_body(&[message("system", "only system")]);
        assert_eq!(empty["contents"], json!([{ "role": "user", "parts": [{ "text": "Hello" }] }]));
    }

    #[test]
    fn parse_google_response_concatenates_parts() {
        let body = json!({
            "candidates": [
                { "content": { "parts": [{ "text": "Hello " }, { "text": "world" }] } },
                { "content": { "parts": [{ "text": "!" }] } },
            ]
        });
        assert_eq!(parse_google_response(&body), "Hello world!");
        assert_eq!(parse_google_response(&json!({})), "");
        assert_eq!(parse_google_response(&json!({ "candidates": [] })), "");
    }

    #[test]
    fn fallback_advice_is_verbatim() {
        assert_eq!(
            fallback_advice("missing values"),
            "The AI service is temporarily unavailable, so here is the offline rule for missing values: \
with no missing values keep listwise handling; with a few incomplete rows drop them; \
with widespread missingness fill numeric columns (mean/median) or categorical columns (mode) \
from the Transform menu, then rerun."
        );
    }

    /// Bug 1 regression: a saved Google key must not hijack the Custom provider.
    /// The Custom branch validates the base URL, so an invalid one fails locally;
    /// a hijacked dispatch would have called generativelanguage.googleapis.com.
    #[tokio::test]
    async fn a_google_looking_key_never_hijacks_a_custom_provider() {
        let settings = crate::settings::AiSettings {
            provider: "custom".to_string(),
            base_url: "not a url".to_string(),
            key: "AIza-saved-google-key".to_string(),
            model: "llama3.2".to_string(),
        };
        let error = chat(&settings, &json!([{ "role": "user", "content": "hi" }]))
            .await
            .unwrap_err();
        assert_eq!(error.kind, AiErrorKind::Configuration);
        assert!(error.user_message.contains("provider URL is invalid"));
    }
}
