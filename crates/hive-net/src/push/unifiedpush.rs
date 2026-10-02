//! A UnifiedPush distributor (spec/push.md 0.3 "Passed on"): the notice as it came, with a VAPID
//! token (RFC 8292) of this server's key, which a distributor that asks for one checks against the
//! key the phone registered with it there: the one the network's profile names (`push.vapid`).

use std::path::Path;

use anyhow::{Context, Result};
use ring::{
    rand::SystemRandom,
    signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING},
};
use serde_json::json;

use super::{
    posted::Urgency,
    service::{Outgoing, Passed},
};
use crate::{jwt, state_file};

/// How long a VAPID token is good for (RFC 8292 §2: at most a day).
const VAPID_FOR: u64 = 12 * 60 * 60;

/// This server's VAPID key, and who its tokens say runs it.
pub(crate) struct Vapid {
    key: EcdsaKeyPair,
    public: String,
    contact: Option<String>,
}

impl Vapid {
    /// The key kept in `dir` (`push-vapid.key`, readable by this user alone), made the first
    /// time; its tokens name `contact` (a `mailto:` or `https:` URL), when there is one.
    pub fn open(dir: &Path, contact: Option<String>) -> Result<Self> {
        let file = dir.join("push-vapid.key");
        let rng = SystemRandom::new();
        let pkcs8 = match std::fs::read_to_string(&file) {
            Ok(text) => hex::decode(text.trim())
                .with_context(|| format!("{} is not a key", file.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let made = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng)
                    .map_err(|_| anyhow::anyhow!("could not make a VAPID key"))?;
                state_file::write_private(
                    &file,
                    format!("{}\n", hex::encode(made.as_ref())).as_bytes(),
                )?;
                made.as_ref().to_vec()
            }
            Err(e) => return Err(e).with_context(|| format!("cannot read {}", file.display())),
        };
        let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &pkcs8, &rng)
            .map_err(|_| anyhow::anyhow!("{} is not a P-256 key", file.display()))?;
        let public = jwt::b64url(key.public_key().as_ref());
        Ok(Self {
            key,
            public,
            contact,
        })
    }

    /// The public key, uncompressed, in base64url: what a phone gives its distributor.
    pub fn public(&self) -> &str {
        &self.public
    }

    /// The `Authorization` of a post to `url` at `now` (s): a token for its origin.
    fn authorization(&self, url: &url::Url, now: u64) -> Result<String> {
        let mut claims = json!({
            "aud": url.origin().ascii_serialization(),
            "exp": now + VAPID_FOR,
        });
        if let Some(contact) = &self.contact {
            claims["sub"] = json!(contact);
        }
        let token = jwt::es256(&self.key, &json!({ "typ": "JWT", "alg": "ES256" }), &claims)?;
        Ok(format!("vapid t={token}, k={}", self.public))
    }
}

/// The request that passes the notice `body` on to a distributor at `url`, as it came, at `now`
/// (s).
pub(crate) fn request(
    url: &url::Url,
    body: &[u8],
    ttl: u64,
    urgency: Urgency,
    vapid: &Vapid,
    now: u64,
) -> Result<Outgoing> {
    Ok(Outgoing {
        url: url.to_string(),
        headers: vec![
            ("authorization", vapid.authorization(url, now)?),
            ("ttl", ttl.to_string()),
            ("urgency", urgency.name().into()),
            ("content-encoding", "aes128gcm".into()),
            ("content-type", "application/octet-stream".into()),
        ],
        body: body.to_vec(),
    })
}

/// What a distributor's answer says of the phone (RFC 8030 §7.3, §8.2).
pub(crate) fn passed(status: u16) -> Passed {
    match status {
        200..=299 => Passed::Delivered,
        404 | 410 => Passed::Gone,
        413 => Passed::TooLarge,
        _ => Passed::Failed(format!("the distributor answered {status}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use ring::signature::{UnparsedPublicKey, ECDSA_P256_SHA256_FIXED};

    fn tmp() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "hive-net-vapid-{}-{:08x}",
            std::process::id(),
            rand::random::<u32>()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_distributor_is_posted_the_notice_as_it_came_with_a_vapid_token_for_its_origin_by_the_key_kept(
    ) {
        let dir = tmp();
        let vapid = Vapid::open(&dir, Some("mailto:admin@example.org".into())).unwrap();
        let url = url::Url::parse("https://ntfy.example.org:8443/up/a-phone?x=1").unwrap();
        let now = 1_790_000_000;
        let out = request(&url, b"ciphertext", 86_400, Urgency::High, &vapid, now).unwrap();
        assert_eq!(out.url, url.to_string());
        assert_eq!(out.body, b"ciphertext");
        let header = |name: &str| {
            out.headers
                .iter()
                .find(|(n, _)| *n == name)
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(header("ttl"), Some("86400"));
        assert_eq!(header("urgency"), Some("high"));
        assert_eq!(header("content-encoding"), Some("aes128gcm"));
        let authorization = header("authorization").unwrap();
        let (token, key) = authorization
            .strip_prefix("vapid t=")
            .unwrap()
            .split_once(", k=")
            .unwrap();
        assert_eq!(key, vapid.public());
        let (head, claims, signed, signature) = jwt::parts(token);
        assert_eq!(head, json!({ "typ": "JWT", "alg": "ES256" }));
        assert_eq!(
            claims,
            json!({ "aud": "https://ntfy.example.org:8443", "exp": now + VAPID_FOR, "sub": "mailto:admin@example.org" })
        );
        let public = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(key)
            .unwrap();
        assert_eq!(public.len(), 65);
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, &public)
            .verify(&signed, &signature)
            .expect("the token is signed by the VAPID key");
        // The key is kept, readable by its user alone, and the same the next time.
        assert_eq!(Vapid::open(&dir, None).unwrap().public(), vapid.public());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join("push-vapid.key"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn a_phone_its_distributor_no_longer_knows_is_gone() {
        for status in [200, 201, 202] {
            assert_eq!(passed(status), Passed::Delivered);
        }
        assert_eq!(passed(404), Passed::Gone);
        assert_eq!(passed(410), Passed::Gone);
        assert_eq!(passed(413), Passed::TooLarge);
        for status in [400, 401, 429, 500, 503] {
            assert!(matches!(passed(status), Passed::Failed(_)), "{status}");
        }
    }
}
