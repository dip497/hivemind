//! What the push role reads from what it is posted (spec/push.md 0.3): a phone's registration; the
//! `Hive-Sender` a device signs a notice with, over the phone's handle, the time and the body; the
//! headers a notice comes with (TTL, Urgency); and whether a body is a Web Push message at all.

use std::str::FromStr;

use anyhow::{bail, ensure, Context, Result};
use hyper::HeaderMap;
use iroh::PublicKey;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::wire::Platform;
use crate::signed;

const NOTICE: &[u8] = b"hive/push-notice/1\n";
/// The largest notice passed on: a Web Push message is at most 4096 bytes (RFC 8291 §4).
pub(crate) const MAX_NOTICE: usize = 4096;
/// The longest token kept: a UnifiedPush address, or a device token.
pub(crate) const MAX_TOKEN: usize = 1000;
/// The most devices a phone names as the ones that may tell it.
pub(crate) const MAX_SENDERS: usize = 100;
/// The longest a notice waits upstream (Apple's and Google's limit): 28 days.
pub(crate) const MAX_TTL: u64 = 28 * 24 * 60 * 60;

/// A registration as a phone posts it.
#[derive(Debug, Deserialize)]
pub(crate) struct Registering {
    pub v: u32,
    pub device: String,
    pub platform: Platform,
    pub token: String,
    #[serde(default)]
    pub sandbox: bool,
    pub senders: Vec<String>,
    pub at: u64,
    pub signature: String,
}

/// Whether `token` can be where a phone is told: something, not too long, with no space or control
/// character in it (each would be read as another part of what the phone signed).
pub(crate) fn token_ok(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= MAX_TOKEN
        && token.chars().all(|c| !c.is_control() && !c.is_whitespace())
}

/// What a device signs to post the notice `body` to the phone of `handle` at `at`.
fn notice_bytes(handle: &str, at: u64, body: &[u8]) -> Vec<u8> {
    let mut bytes = NOTICE.to_vec();
    bytes.extend(handle.as_bytes());
    bytes.push(b'\n');
    bytes.extend(at.to_string().as_bytes());
    bytes.push(b'\n');
    bytes.extend(Sha256::digest(body));
    bytes
}

/// The device that signed the post of `body` to the phone of `handle` (its `Hive-Sender`), and
/// when, if the signature is its and the time is near `now`.
pub(crate) fn sender_of(
    headers: &HeaderMap,
    handle: &str,
    body: &[u8],
    now: u64,
) -> Result<(String, u64)> {
    let given = headers
        .get("hive-sender")
        .and_then(|v| v.to_str().ok())
        .context("a notice says which device posts it (Hive-Sender)")?;
    let mut parts = given.split(' ');
    let (Some(device), Some(at), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        bail!("Hive-Sender is the device, the time and the signature");
    };
    let device = PublicKey::from_str(device).context("Hive-Sender names no device")?;
    let at: u64 = at
        .parse()
        .context("Hive-Sender's time is ms since the epoch")?;
    ensure!(
        signed::near(at, now),
        "the notice's time is too far from now"
    );
    signed::verify(&device, &notice_bytes(handle, at, body), signature)
        .context("the notice is not signed by the device it names")?;
    Ok((device.to_string(), at))
}

/// How long a notice may wait for the phone (RFC 8030 §5.2: a push service asks for it), in
/// seconds, at most 28 days.
pub(crate) fn ttl_of(headers: &HeaderMap) -> Option<u64> {
    let given = headers.get("ttl")?.to_str().ok()?.trim();
    if given.is_empty() || !given.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // A number too large for u64 is the longest there is.
    Some(given.parse::<u64>().unwrap_or(u64::MAX).min(MAX_TTL))
}

/// How urgent a notice is, as the device that posted it says (RFC 8030 §5.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Urgency {
    VeryLow,
    Low,
    Normal,
    High,
}

impl Urgency {
    pub(crate) fn of(headers: &HeaderMap) -> Self {
        let given = headers
            .get("urgency")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.trim().to_ascii_lowercase());
        match given.as_deref() {
            Some("very-low") => Self::VeryLow,
            Some("low") => Self::Low,
            Some("high") => Self::High,
            _ => Self::Normal,
        }
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::VeryLow => "very-low",
            Self::Low => "low",
            Self::Normal => "normal",
            Self::High => "high",
        }
    }
}

/// Whether `body` is a Web Push message (RFC 8291, over RFC 8188's `aes128gcm`): a salt, a record
/// size of at least 18, the sender's public key (65 bytes, uncompressed), and one record no larger
/// than that size of at least a delimiter and its tag. Anything else is not passed on: the role
/// carries notices, not whatever its callers would have it post.
pub(crate) fn web_push(body: &[u8]) -> bool {
    const HEADER: usize = 16 + 4 + 1 + 65;
    if body.len() < HEADER + 17 || body.len() > MAX_NOTICE {
        return false;
    }
    let rs = u32::from_be_bytes([body[16], body[17], body[18], body[19]]) as usize;
    rs >= 18 && body[20] == 65 && body[21] == 0x04 && body.len() - HEADER <= rs
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use serde_json::Value;

    fn unb64url(s: &str) -> Vec<u8> {
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(s)
            .unwrap()
    }

    fn with(name: &str, value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            hyper::header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
            value.parse().unwrap(),
        );
        headers
    }

    #[test]
    fn a_notice_is_the_device_s_its_header_names_while_its_time_is_near_and_its_handle_and_body_the_ones_signed(
    ) {
        let conformance: Value =
            serde_json::from_str(include_str!("../../../../conformance/push.json")).unwrap();
        let vector = &conformance["sender"];
        let body = unb64url(conformance["rfc8291"]["body"].as_str().unwrap());
        let at = vector["at"].as_u64().unwrap();
        let handle = vector["handle"].as_str().unwrap();
        let signed = vector["header"].as_str().unwrap();
        let device = vector["device"].as_str().unwrap().to_string();
        let sender = |value: &str, handle: &str, body: &[u8], now: u64| {
            sender_of(&with("hive-sender", value), handle, body, now)
        };
        assert_eq!(
            sender(signed, handle, &body, at).unwrap(),
            (device.clone(), at)
        );
        // Ten minutes either side of the server's clock is near enough; more is not.
        assert!(sender(signed, handle, &body, at + signed::CLOCK_SKEW_MS).is_ok());
        assert!(sender(signed, handle, &body, at + signed::CLOCK_SKEW_MS + 1).is_err());
        assert!(sender(signed, handle, &body, at - signed::CLOCK_SKEW_MS - 1).is_err());
        // Another body, another phone, another time or another device than the ones signed.
        let mut changed = body.clone();
        changed[100] ^= 1;
        assert!(sender(signed, handle, &changed, at).is_err());
        assert!(sender(signed, &"0".repeat(32), &body, at).is_err());
        let later = signed.replace(&format!(" {at} "), &format!(" {} ", at + 1));
        assert!(sender(&later, handle, &body, at).is_err());
        let other = iroh::SecretKey::from_bytes(&[7; 32]).public().to_string();
        assert!(sender(&signed.replacen(&device, &other, 1), handle, &body, at).is_err());
        // Nothing said, or not all of it, or more.
        assert!(sender_of(&HeaderMap::new(), handle, &body, at).is_err());
        let (short, _) = signed.rsplit_once(' ').unwrap();
        assert!(sender(short, handle, &body, at).is_err());
        assert!(sender(&format!("{signed} more"), handle, &body, at).is_err());
    }

    #[test]
    fn a_web_push_message_is_one_record_from_an_uncompressed_key_and_nothing_else_is() {
        let conformance: Value =
            serde_json::from_str(include_str!("../../../../conformance/push.json")).unwrap();
        let body = unb64url(conformance["rfc8291"]["body"].as_str().unwrap());
        assert!(web_push(&body));
        let mut compressed = body.clone();
        compressed[20] = 33;
        assert!(!web_push(&compressed));
        let mut not_a_point = body.clone();
        not_a_point[21] = 0x02;
        assert!(!web_push(&not_a_point));
        let mut tiny_records = body.clone();
        tiny_records[16..20].copy_from_slice(&17u32.to_be_bytes());
        assert!(!web_push(&tiny_records));
        let mut two_records = body.clone();
        two_records[16..20].copy_from_slice(&40u32.to_be_bytes());
        assert!(!web_push(&two_records));
        assert!(!web_push(&body[..86 + 16]));
        assert!(!web_push(br#"{"a":"json body"}"#));
        let mut largest = body[..86].to_vec();
        largest.resize(MAX_NOTICE, 0);
        assert!(web_push(&largest));
        largest.push(0);
        assert!(!web_push(&largest));
    }

    #[test]
    fn a_notice_says_how_long_it_may_wait_and_how_urgent_it_is() {
        assert_eq!(ttl_of(&with("ttl", "86400")), Some(86_400));
        assert_eq!(ttl_of(&with("ttl", "0")), Some(0));
        assert_eq!(
            ttl_of(&with("ttl", "99999999999999999999999")),
            Some(MAX_TTL)
        );
        assert_eq!(ttl_of(&with("ttl", "3000000")), Some(MAX_TTL));
        for bad in ["", "-1", "1.5", "a day"] {
            assert_eq!(ttl_of(&with("ttl", bad)), None, "{bad:?}");
        }
        assert_eq!(ttl_of(&HeaderMap::new()), None);
        assert_eq!(Urgency::of(&with("urgency", "high")), Urgency::High);
        assert_eq!(Urgency::of(&with("urgency", "High")), Urgency::High);
        assert_eq!(Urgency::of(&with("urgency", "very-low")), Urgency::VeryLow);
        assert_eq!(Urgency::of(&with("urgency", "soon")), Urgency::Normal);
        assert_eq!(Urgency::of(&HeaderMap::new()), Urgency::Normal);
    }

    #[test]
    fn a_token_is_one_word_of_printable_characters_and_not_too_long() {
        assert!(token_ok("https://ntfy.example.org/up/1"));
        assert!(token_ok(&"a".repeat(MAX_TOKEN)));
        for bad in [
            String::new(),
            "a".repeat(MAX_TOKEN + 1),
            "a b".into(),
            "a\nb".into(),
            "a\u{7f}".into(),
        ] {
            assert!(!token_ok(&bad), "{bad:?}");
        }
    }
}
