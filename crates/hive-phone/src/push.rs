//! What happens while the person is away, told to their phone (M5, spec/push.md): the phone keeps
//! a push key (P-256) and a secret, gives each of the person's devices where to tell it (a Web Push
//! subscription), and decrypts what they send (RFC 8291, over RFC 8188's `aes128gcm`). Whatever
//! carries a notice reads nothing of it. Held to `conformance/push.json`. On a network with a push
//! server, the phone registers there, naming the devices that may tell it, and is told through it
//! (0.3).

use std::{fs, path::Path};

use aes_gcm::{aead::Aead, Aes128Gcm, KeyInit as _, Nonce};
use anyhow::{bail, ensure, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, KeyInit as _, Mac};
use iroh::endpoint::Connection;
use p256::{elliptic_curve::sec1::ToEncodedPoint, PublicKey, SecretKey};
use serde_json::{json, Value};
use sha2::Sha256;

use hive_net::push::{client, Platform};
use serde::{Deserialize, Serialize};

use crate::{devices, identity::write_private};

/// Where this phone last registered at its network's push server, kept beside its keys.
const REGISTERED: &str = "push-server.json";

fn hmac(key: &[u8], data: &[&[u8]]) -> [u8; 32] {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes any key");
    for d in data {
        mac.update(d);
    }
    mac.finalize().into_bytes().into()
}

/// The phone's push keys: its P-256 key, and the secret that authenticates what it is sent.
pub struct PushKeys {
    secret: SecretKey,
    auth: [u8; 16],
}

impl PushKeys {
    /// The keys kept in `dir` (`push.key`, `push.auth`, as hex, readable by this user alone),
    /// made the first time.
    pub fn kept_or_made(dir: &Path) -> Result<Self> {
        let (key, auth) = (dir.join("push.key"), dir.join("push.auth"));
        if key.exists() && auth.exists() {
            let secret = hex::decode(fs::read_to_string(&key)?.trim())?;
            let auth = hex::decode(fs::read_to_string(&auth)?.trim())?;
            return Ok(Self {
                secret: SecretKey::from_slice(&secret).context("push.key is not a P-256 key")?,
                auth: auth.try_into().ok().context("push.auth is not 16 bytes")?,
            });
        }
        // Random bytes are a key but for the rarest few, which are drawn again.
        let secret = loop {
            if let Ok(s) = SecretKey::from_slice(&rand::random::<[u8; 32]>()) {
                break s;
            }
        };
        let made = Self {
            secret,
            auth: rand::random(),
        };
        write_private(&key, &format!("{}\n", hex::encode(made.secret.to_bytes())))?;
        write_private(&auth, &format!("{}\n", hex::encode(made.auth)))?;
        Ok(made)
    }

    /// Its public key, uncompressed (65 bytes).
    pub fn public(&self) -> Vec<u8> {
        self.secret
            .public_key()
            .to_encoded_point(false)
            .as_bytes()
            .to_vec()
    }

    /// Where it is told, and with what: a Web Push subscription; one that asks each device to sign
    /// what it posts when `sign` (a push server's endpoint, spec/push.md 0.3).
    pub fn subscription(&self, endpoint: &str, sign: bool) -> Value {
        let mut subscription = json!({
            "endpoint": endpoint,
            "p256dh": URL_SAFE_NO_PAD.encode(self.public()),
            "auth": URL_SAFE_NO_PAD.encode(self.auth),
        });
        if sign {
            subscription["sign"] = json!(true);
        }
        subscription
    }

    /// What `body`, sent to this phone, says (RFC 8291 §3.4, RFC 8188 §2): refused when it is not
    /// for this phone, or was changed on its way. A notice is one record (spec/push.md).
    pub fn decrypt(&self, body: &[u8]) -> Result<Vec<u8>> {
        ensure!(body.len() > 21, "not a push message");
        let salt = &body[..16];
        let rs = u32::from_be_bytes(body[16..20].try_into()?) as usize;
        let idlen = body[20] as usize;
        ensure!(body.len() > 21 + idlen, "not a push message");
        let (sender, record) = body[21..].split_at(idlen);
        ensure!(
            rs > 17 && record.len() <= rs,
            "a push message of more than one record"
        );
        // The sender's key, uncompressed (RFC 8291 §4).
        ensure!(
            idlen == 65 && sender[0] == 0x04,
            "a push message from a key not given whole"
        );
        let shared = p256::ecdh::diffie_hellman(
            self.secret.to_nonzero_scalar(),
            PublicKey::from_sec1_bytes(sender)
                .context("not a push message")?
                .as_affine(),
        );
        // The shared secret, combined with this phone's (RFC 8291 §3.3).
        let prk_key = hmac(&self.auth, &[shared.raw_secret_bytes().as_slice()]);
        let ikm = hmac(
            &prk_key,
            &[b"WebPush: info\0", &self.public(), sender, &[1]],
        );
        // The content encryption key and nonce (RFC 8188 §2.2, §2.3).
        let prk = hmac(salt, &[&ikm]);
        let cek = &hmac(&prk, &[b"Content-Encoding: aes128gcm\0\x01"])[..16];
        let nonce = &hmac(&prk, &[b"Content-Encoding: nonce\0\x01"])[..12];
        let plain = Aes128Gcm::new_from_slice(cek)
            .ok()
            .context("a content key is 16 bytes")?
            .decrypt(Nonce::from_slice(nonce), record)
            .ok()
            .context("a push message not for this phone, or changed on its way")?;
        // Its padding: the delimiter of the last record, 2, then zeros.
        let end = plain
            .iter()
            .rposition(|&b| b != 0)
            .context("a record with no delimiter")?;
        ensure!(plain[end] == 2, "a record that is not the last");
        Ok(plain[..end].to_vec())
    }
}

/// Give the device on `connection` where this phone is told what happens there, `subscription`.
pub async fn subscribe(connection: &Connection, subscription: &Value) -> Result<()> {
    let mut given = subscription.clone();
    given["t"] = json!("push");
    let answer = devices::ask(connection, &given).await?;
    if answer.get("ok").and_then(Value::as_bool) != Some(true) {
        bail!("{}", devices::refusal(&answer));
    }
    Ok(())
}

/// Where this phone registered to be told through a push server: the server, and where it tells
/// the phone.
#[derive(Serialize, Deserialize)]
struct Registered {
    url: String,
    platform: Platform,
    token: String,
    sandbox: bool,
}

/// Register at the push server `url` to be told at `platform`'s `token` by the devices `senders`
/// (spec/push.md 0.3), keeping where in `dir`: the address those devices tell this phone at.
pub async fn register(
    dir: &Path,
    key: &iroh::SecretKey,
    url: &str,
    (platform, token, sandbox): (Platform, &str, bool),
    senders: &[iroh::PublicKey],
) -> Result<String> {
    let endpoint = client::register(url, key, platform, token, sandbox, senders).await?;
    let kept = Registered {
        url: url.into(),
        platform,
        token: token.into(),
        sandbox,
    };
    write_private(&dir.join(REGISTERED), &serde_json::to_string(&kept)?)?;
    Ok(endpoint)
}

/// Register anew where this phone last registered, to be told by `senders` alone now (one was
/// unpaired): so a device it no longer names posts it nothing. False when it registered nowhere.
pub async fn register_again(
    dir: &Path,
    key: &iroh::SecretKey,
    senders: &[iroh::PublicKey],
) -> Result<bool> {
    let Ok(text) = fs::read_to_string(dir.join(REGISTERED)) else {
        return Ok(false);
    };
    let kept: Registered =
        serde_json::from_str(&text).with_context(|| format!("{REGISTERED} is not one"))?;
    client::register(
        &kept.url,
        key,
        kept.platform,
        &kept.token,
        kept.sandbox,
        senders,
    )
    .await?;
    Ok(true)
}
