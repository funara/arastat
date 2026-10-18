//! URL/IP policy for AI provider endpoints. Ported from `src/main/modelCall.ts`,
//! with the ARAStat LAN amendment: plain HTTP is additionally allowed for RFC1918
//! private hosts and mDNS/link-local names, while cloud-metadata, unspecified and
//! multicast/reserved addresses stay blocked on every scheme.

use url::Url;

const INVALID_URL: &str =
    "The AI provider URL is invalid. Use a public HTTPS or local OpenAI-compatible endpoint.";
const REJECTED_URL: &str = "The AI provider URL must be a public HTTPS endpoint or local HTTP endpoint without embedded credentials, query strings, or fragments.";

/// Chat-completions URL for an OpenAI-compatible base URL.
pub fn endpoint_for(base_url: &str) -> Result<String, String> {
    with_path_suffix(base_url, "/chat/completions")
}

/// `/models` URL for an OpenAI-compatible base URL.
pub fn models_endpoint_for(base_url: &str) -> Result<String, String> {
    with_path_suffix(base_url, "/models")
}

pub fn is_localhost(host: &str) -> bool {
    let host = normalize_host(host);
    host == "localhost" || host.ends_with(".localhost") || host == "127.0.0.1" || host == "::1"
}

fn with_path_suffix(base_url: &str, suffix: &str) -> Result<String, String> {
    let url = validated(base_url)?;
    // Validated URLs carry no query or fragment, so the serialized form ends in the path.
    let mut endpoint = url.to_string();
    while endpoint.ends_with('/') {
        endpoint.pop();
    }
    if !endpoint.ends_with(suffix) {
        endpoint.push_str(suffix);
    }
    Ok(endpoint)
}

fn validated(base_url: &str) -> Result<Url, String> {
    let url = Url::parse(base_url.trim()).map_err(|_| INVALID_URL.to_string())?;
    let host = url.host_str().unwrap_or("").to_string();
    let has_userinfo = !url.username().is_empty() || url.password().is_some();
    if host.is_empty()
        || has_userinfo
        || url.query().is_some()
        || url.fragment().is_some()
        || is_sensitive_network_host(&host)
    {
        return Err(REJECTED_URL.to_string());
    }
    match url.scheme() {
        "https" => Ok(url),
        "http" if http_host_allowed(&host) => Ok(url),
        _ => Err(REJECTED_URL.to_string()),
    }
}

fn normalize_host(host: &str) -> String {
    let mut host = host.trim().to_ascii_lowercase();
    if host.starts_with('[') && host.ends_with(']') {
        host.remove(0);
        host.pop();
    }
    while host.ends_with('.') {
        host.pop();
    }
    host
}

fn ipv4_value(host: &str) -> Option<u32> {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut value: u32 = 0;
    for part in parts {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let octet: u32 = part.parse().ok()?;
        if octet > 255 {
            return None;
        }
        value = value * 256 + octet;
    }
    Some(value)
}

/// Loopback, RFC1918 private LAN, or IPv4 link-local.
fn is_lan_ipv4(value: u32) -> bool {
    (value >> 24) == 127
        || (value >> 24) == 10
        || (0xac10_0000..=0xac1f_ffff).contains(&value)
        || (0xc0a8_0000..=0xc0a8_ffff).contains(&value)
        || (0xa9fe_0000..=0xa9fe_ffff).contains(&value)
}

/// Blocked on every scheme: unspecified, cloud-metadata, multicast/reserved.
fn is_sensitive_ipv4(value: u32) -> bool {
    value <= 0x00ff_ffff || value == 0xa9fe_a9fe || value >= 0xe000_0000
}

fn parse_ipv6_words(host: &str) -> Option<[u16; 8]> {
    fn parse_half(part: &str) -> Option<Vec<u16>> {
        if part.is_empty() {
            return Some(Vec::new());
        }
        let mut words = Vec::new();
        for piece in part.split(':') {
            if piece.contains('.') {
                let value = ipv4_value(piece)?;
                words.push((value >> 16) as u16);
                words.push((value & 0xffff) as u16);
            } else {
                if piece.is_empty() || piece.len() > 4 || !piece.bytes().all(|b| b.is_ascii_hexdigit())
                {
                    return None;
                }
                words.push(u16::from_str_radix(piece, 16).ok()?);
            }
        }
        Some(words)
    }

    let (left_raw, right_raw) = match host.split_once("::") {
        Some((left, right)) => (left, Some(right)),
        None => (host, None),
    };
    let left = parse_half(left_raw)?;
    let right = match right_raw {
        Some(right) => parse_half(right)?,
        None => Vec::new(),
    };
    let total = left.len() + right.len();
    if right_raw.is_some() {
        if total >= 8 {
            return None;
        }
    } else if total != 8 {
        return None;
    }
    let mut words = [0u16; 8];
    for (i, word) in left.iter().enumerate() {
        words[i] = *word;
    }
    let offset = 8 - right.len();
    for (i, word) in right.iter().enumerate() {
        words[offset + i] = *word;
    }
    Some(words)
}

fn is_loopback_ipv6(words: &[u16; 8]) -> bool {
    words[..7] == [0u16; 7] && words[7] == 1
}

fn is_link_local_ipv6(words: &[u16; 8]) -> bool {
    words[0] & 0xffc0 == 0xfe80
}

/// Blocked on every scheme: unspecified, multicast, or an IPv4-mapped blocked address.
fn is_sensitive_ipv6(words: &[u16; 8]) -> bool {
    if words.iter().all(|word| *word == 0) {
        return true;
    }
    let mapped = words[..5].iter().all(|word| *word == 0) && words[5] == 0xffff;
    if mapped {
        return is_sensitive_ipv4(((words[6] as u32) << 16) | words[7] as u32);
    }
    words[0] & 0xff00 == 0xff00
}

/// Blocked on every scheme, whatever the host looks like.
fn is_sensitive_network_host(host: &str) -> bool {
    let host = normalize_host(host);
    if let Some(value) = ipv4_value(&host) {
        return is_sensitive_ipv4(value);
    }
    if let Some(words) = parse_ipv6_words(&host) {
        return is_sensitive_ipv6(&words);
    }
    false
}

/// Plain HTTP is limited to loopback, RFC1918 LAN, and link-local/mDNS addresses.
fn http_host_allowed(host: &str) -> bool {
    let host = normalize_host(host);
    if let Some(value) = ipv4_value(&host) {
        return is_lan_ipv4(value);
    }
    if let Some(words) = parse_ipv6_words(&host) {
        return is_loopback_ipv6(&words) || is_link_local_ipv6(&words);
    }
    host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn https_public_endpoint_gets_completion_path() {
        let url = endpoint_for("https://api.openai.com/v1").expect("public https allowed");
        assert!(url.ends_with("/v1/chat/completions"), "{url}");
    }

    #[test]
    fn https_does_not_duplicate_completion_path() {
        let url = endpoint_for("https://api.openai.com/v1/chat/completions").expect("allowed");
        assert!(url.ends_with("/v1/chat/completions"), "{url}");
        assert_eq!(url.matches("/chat/completions").count(), 1, "{url}");
    }

    #[test]
    fn http_loopback_allowed() {
        assert!(endpoint_for("http://localhost:11434/v1").is_ok());
        assert!(endpoint_for("http://127.0.0.1:11434/v1").is_ok());
        assert!(endpoint_for("http://[::1]:11434/v1").is_ok());
    }

    #[test]
    fn http_rfc1918_allowed() {
        assert!(endpoint_for("http://192.168.1.50:11434/v1").is_ok());
        assert!(endpoint_for("http://10.0.0.7/v1").is_ok());
        assert!(endpoint_for("http://172.16.5.5/v1").is_ok());
        assert!(endpoint_for("http://172.31.255.254/v1").is_ok());
    }

    #[test]
    fn http_public_host_rejected() {
        assert!(endpoint_for("http://8.8.8.8/v1").is_err());
        assert!(endpoint_for("http://172.32.0.1/v1").is_err());
        assert!(endpoint_for("http://api.openai.com/v1").is_err());
    }

    #[test]
    fn http_mdns_and_link_local_allowed() {
        assert!(endpoint_for("http://ollama.local:11434/v1").is_ok());
        assert!(endpoint_for("http://169.254.10.10/v1").is_ok());
        assert!(endpoint_for("http://[fe80::1]:11434/v1").is_ok());
    }

    #[test]
    fn cloud_metadata_blocked_on_every_scheme() {
        assert!(endpoint_for("http://169.254.169.254/latest").is_err());
        assert!(endpoint_for("https://169.254.169.254/latest").is_err());
        assert!(endpoint_for("https://[::ffff:169.254.169.254]/v1").is_err());
    }

    #[test]
    fn unspecified_and_multicast_blocked() {
        assert!(endpoint_for("http://0.0.0.0/v1").is_err());
        assert!(endpoint_for("http://224.0.0.1/v1").is_err());
        assert!(endpoint_for("https://239.1.2.3/v1").is_err());
        assert!(endpoint_for("https://[::]/v1").is_err());
        assert!(endpoint_for("https://[ff02::1]/v1").is_err());
    }

    #[test]
    fn https_private_host_allowed() {
        assert!(endpoint_for("https://8.8.8.8/v1").is_ok());
        assert!(endpoint_for("https://192.168.1.50/v1").is_ok());
    }

    #[test]
    fn credentials_query_and_fragment_rejected() {
        assert!(endpoint_for("https://user:pw@api.openai.com/v1").is_err());
        assert!(endpoint_for("https://api.openai.com/v1?key=x").is_err());
        assert!(endpoint_for("https://api.openai.com/v1#frag").is_err());
        assert!(models_endpoint_for("https://api.openai.com/v1?key=x").is_err());
    }

    #[test]
    fn invalid_url_uses_parse_copy() {
        assert_eq!(endpoint_for("not a url").unwrap_err(), INVALID_URL);
        assert_eq!(endpoint_for("").unwrap_err(), INVALID_URL);
        assert_eq!(endpoint_for("ftp://example.com/v1").unwrap_err(), REJECTED_URL);
    }

    #[test]
    fn localhost_detection() {
        assert!(is_localhost("localhost"));
        assert!(is_localhost("foo.localhost"));
        assert!(is_localhost("127.0.0.1"));
        assert!(is_localhost("[::1]"));
        assert!(is_localhost(" LOCALHOST. "));
        assert!(!is_localhost("192.168.1.1"));
        assert!(!is_localhost("ollama.local"));
    }

    #[test]
    fn models_endpoint() {
        let url = models_endpoint_for("https://api.openai.com/v1").expect("allowed");
        assert!(url.ends_with("/v1/models"), "{url}");
        let url = models_endpoint_for("http://localhost:11434").expect("loopback allowed");
        assert!(url.ends_with("/models"), "{url}");
        assert!(url.contains(":11434"), "{url}");
    }

    #[test]
    fn trailing_slashes_and_ports_preserved() {
        let url = endpoint_for("http://192.168.1.50:8080/v1/").expect("lan allowed");
        assert!(url.ends_with("/v1/chat/completions"), "{url}");
        assert!(url.contains(":8080"), "{url}");
    }
}
