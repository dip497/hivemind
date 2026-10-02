//! Apple's push service (design §12.4, spec/push.md 0.3 "Passed on"): an alert its app's
//! Notification Service Extension replaces with the notice it decrypts, sent with a provider token
//! this server's key signs.

use std::sync::Mutex;

use anyhow::Result;
use ring::{
    rand::SystemRandom,
    signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING},
};
use serde_json::{json, Value};

use super::{wire::Urgency, Outgoing, Passed};
use crate::jwt;

/// What a phone's notification says until the phone has decrypted the notice.
const ALERT: (&str, &str) = ("hivemind", "Something on your devices needs a look");
/// The largest payload Apple takes for an alert.
const MAX_PAYLOAD: usize = 4096;
/// How long a provider token is used: Apple takes one for up to an hour, and no new one more
/// often than every twenty minutes.
const TOKEN_FOR: u64 = 30 * 60;

/// Apple's push service, with this server's key for it: a `.p8` file, its id, the team's id and
/// the app's bundle id.
pub struct Apns {
    key: EcdsaKeyPair,
    key_id: String,
    team: String,
    topic: String,
    /// The token last made, and when (s).
    token: Mutex<Option<(String, u64)>>,
}

impl Apns {
    pub fn new(p8: &str, key_id: &str, team: &str, topic: &str) -> Result<Self> {
        let key = EcdsaKeyPair::from_pkcs8(
            &ECDSA_P256_SHA256_FIXED_SIGNING,
            &jwt::pem_der(p8)?,
            &SystemRandom::new(),
        )
        .map_err(|e| anyhow::anyhow!("the APNs key is not a P-256 key in PKCS#8: {e}"))?;
        Ok(Self {
            key,
            key_id: key_id.into(),
            team: team.into(),
            topic: topic.into(),
            token: Mutex::new(None),
        })
    }

    /// The provider token at `now` (s): the one made in the last 30 minutes, or a new one.
    fn bearer(&self, now: u64) -> Result<String> {
        let mut kept = self.token.lock().unwrap();
        if let Some((token, at)) = kept.as_ref() {
            if now.saturating_sub(*at) < TOKEN_FOR {
                return Ok(token.clone());
            }
        }
        let token = jwt::es256(
            &self.key,
            &json!({ "alg": "ES256", "kid": self.key_id }),
            &json!({ "iss": self.team, "iat": now }),
        )?;
        *kept = Some((token.clone(), now));
        Ok(token)
    }

    /// The request that tells the phone of device token `token` the notice `payload` (`payload`),
    /// at `now` (s).
    pub(crate) fn request(
        &self,
        token: &str,
        sandbox: bool,
        payload: Vec<u8>,
        ttl: u64,
        urgency: Urgency,
        now: u64,
    ) -> Result<Outgoing> {
        let host = if sandbox {
            "api.sandbox.push.apple.com"
        } else {
            "api.push.apple.com"
        };
        let priority = if urgency == Urgency::High { "10" } else { "5" };
        // A TTL of 0 asks Apple to try once and keep nothing.
        let expiration = if ttl == 0 { 0 } else { now + ttl };
        Ok(Outgoing {
            url: format!("https://{host}/3/device/{token}"),
            headers: vec![
                ("authorization", format!("bearer {}", self.bearer(now)?)),
                ("apns-topic", self.topic.clone()),
                ("apns-push-type", "alert".into()),
                ("apns-priority", priority.into()),
                ("apns-expiration", expiration.to_string()),
                ("content-type", "application/json".into()),
            ],
            body: payload,
        })
    }

    /// Apple's answer was that the provider token is too old: the next request makes a new one.
    pub(crate) fn forget_token(&self, status: u16, answer: &str) {
        if status == 403 && reason(answer) == "ExpiredProviderToken" {
            *self.token.lock().unwrap() = None;
        }
    }
}

/// The alert that carries the notice `body`, for the phone to decrypt; none when it is too large
/// for Apple.
pub(crate) fn payload(body: &[u8]) -> Option<Vec<u8>> {
    let payload = json!({
        "aps": { "alert": { "title": ALERT.0, "body": ALERT.1 }, "mutable-content": 1 },
        "m": jwt::b64url(body),
    })
    .to_string()
    .into_bytes();
    (payload.len() <= MAX_PAYLOAD).then_some(payload)
}

fn reason(answer: &str) -> String {
    serde_json::from_str::<Value>(answer)
        .ok()
        .and_then(|v| v["reason"].as_str().map(str::to_string))
        .unwrap_or_default()
}

/// What Apple's answer says of the phone: one it no longer knows, or whose token is no token. A
/// token for another app (`DeviceTokenNotForTopic`) is a failure, not a phone gone: a server given
/// the wrong bundle id would drop every phone.
pub(crate) fn passed(status: u16, answer: &str) -> Passed {
    let reason = reason(answer);
    match status {
        200 => Passed::Delivered,
        410 => Passed::Gone,
        400 if reason == "BadDeviceToken" => Passed::Gone,
        413 => Passed::TooLarge,
        _ => Passed::Failed(format!("APNs answered {status} {reason}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use ring::signature::{KeyPair, UnparsedPublicKey, ECDSA_P256_SHA256_FIXED};

    fn pem(der: &[u8]) -> String {
        let b64 = base64::engine::general_purpose::STANDARD.encode(der);
        let lines: Vec<&str> = b64
            .as_bytes()
            .chunks(64)
            .map(|c| std::str::from_utf8(c).unwrap())
            .collect();
        format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            lines.join("\n")
        )
    }

    fn header(out: &Outgoing, name: &str) -> Option<String> {
        out.headers
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| v.clone())
    }

    #[test]
    fn apple_is_asked_for_an_alert_the_phone_replaces_with_the_notice_it_decrypts_by_a_token_its_key_signs(
    ) {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
        let public =
            EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
                .unwrap()
                .public_key()
                .as_ref()
                .to_vec();
        let apns = Apns::new(
            &pem(pkcs8.as_ref()),
            "KEY1234567",
            "TEAM123456",
            "com.example.hive",
        )
        .unwrap();
        let now = 1_790_000_000;
        let body = b"a notice, encrypted to the phone";
        let request = |sandbox, ttl, urgency, at| {
            apns.request("00ff", sandbox, payload(body).unwrap(), ttl, urgency, at)
                .unwrap()
        };
        let out = request(false, 86_400, Urgency::High, now);
        assert_eq!(out.url, "https://api.push.apple.com/3/device/00ff");
        assert_eq!(
            header(&out, "apns-topic").as_deref(),
            Some("com.example.hive")
        );
        assert_eq!(header(&out, "apns-push-type").as_deref(), Some("alert"));
        assert_eq!(header(&out, "apns-priority").as_deref(), Some("10"));
        assert_eq!(
            header(&out, "apns-expiration"),
            Some((now + 86_400).to_string())
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&out.body).unwrap(),
            json!({
                "aps": { "alert": { "title": "hivemind", "body": "Something on your devices needs a look" }, "mutable-content": 1 },
                "m": jwt::b64url(body),
            })
        );
        // The provider token: ES256 by the key of that id, the team's, when it was made.
        let bearer = header(&out, "authorization").unwrap();
        let (head, claims, signed, signature) = jwt::parts(bearer.strip_prefix("bearer ").unwrap());
        assert_eq!(head, json!({ "alg": "ES256", "kid": "KEY1234567" }));
        assert_eq!(claims, json!({ "iss": "TEAM123456", "iat": now }));
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, &public)
            .verify(&signed, &signature)
            .expect("the token is signed by the APNs key");
        // The same token for half an hour, a new one after; and a new one once Apple says it is
        // too old.
        let bearer_at =
            |at| header(&request(false, 86_400, Urgency::High, at), "authorization").unwrap();
        assert_eq!(bearer_at(now + TOKEN_FOR - 1), bearer);
        let renewed = bearer_at(now + TOKEN_FOR);
        assert_ne!(renewed, bearer);
        assert_eq!(
            jwt::parts(renewed.strip_prefix("bearer ").unwrap()).1["iat"],
            now + TOKEN_FOR
        );
        apns.forget_token(403, r#"{"reason":"BadTopic"}"#);
        assert_eq!(bearer_at(now + TOKEN_FOR + 1), renewed);
        apns.forget_token(403, r#"{"reason":"ExpiredProviderToken"}"#);
        assert_ne!(bearer_at(now + TOKEN_FOR + 1), renewed);
        // A build not from the store is told through Apple's development service; a notice not
        // urgent at priority 5; one with no TTL is kept nowhere.
        let dev = request(true, 0, Urgency::Normal, now);
        assert_eq!(dev.url, "https://api.sandbox.push.apple.com/3/device/00ff");
        assert_eq!(header(&dev, "apns-priority").as_deref(), Some("5"));
        assert_eq!(header(&dev, "apns-expiration").as_deref(), Some("0"));
        // A key that is not P-256: refused as the server starts.
        assert!(Apns::new(&pem(b"not a key"), "K", "T", "t").is_err());
    }

    #[test]
    fn a_notice_too_large_for_apple_is_not_sent() {
        // The alert and the key take 113 bytes: 2987 bytes of notice fit, base64url, in 4096.
        assert!(payload(&[0; 2987]).is_some_and(|p| p.len() == MAX_PAYLOAD));
        assert!(payload(&[0; 2988]).is_none());
    }

    #[test]
    fn a_phone_apple_no_longer_knows_or_whose_token_is_no_token_is_gone_and_any_other_answer_a_failure(
    ) {
        assert_eq!(passed(200, ""), Passed::Delivered);
        assert_eq!(passed(410, r#"{"reason":"Unregistered"}"#), Passed::Gone);
        assert_eq!(passed(410, r#"{"reason":"ExpiredToken"}"#), Passed::Gone);
        assert_eq!(passed(400, r#"{"reason":"BadDeviceToken"}"#), Passed::Gone);
        assert_eq!(
            passed(413, r#"{"reason":"PayloadTooLarge"}"#),
            Passed::TooLarge
        );
        for (status, answer) in [
            (400, r#"{"reason":"DeviceTokenNotForTopic"}"#),
            (400, r#"{"reason":"TopicDisallowed"}"#),
            (403, r#"{"reason":"ExpiredProviderToken"}"#),
            (429, r#"{"reason":"TooManyRequests"}"#),
            (500, ""),
        ] {
            assert!(
                matches!(passed(status, answer), Passed::Failed(_)),
                "{status} {answer}"
            );
        }
    }
}
