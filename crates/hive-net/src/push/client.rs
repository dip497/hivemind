//! A phone's side of the push role (spec/push.md 0.3, "Registering").

use anyhow::{bail, Context, Result};
use iroh::{PublicKey, SecretKey};
use serde_json::{json, Value};

use super::wire::{register_bytes, Platform};
use crate::{egress, signed::now_ms};

/// Register the phone of key `key` at the push role `url`, to be told at `platform`'s `token` by
/// the devices `senders`: the address those devices tell it at, the same each time.
pub async fn register(
    url: &str,
    key: &SecretKey,
    platform: Platform,
    token: &str,
    sandbox: bool,
    senders: &[PublicKey],
) -> Result<String> {
    let device = key.public().to_string();
    let senders: Vec<String> = senders.iter().map(PublicKey::to_string).collect();
    let at = now_ms();
    let signature = hex::encode(
        key.sign(&register_bytes(
            &device, platform, token, sandbox, &senders, at,
        ))
        .to_bytes(),
    );
    let base = url.trim_end_matches('/');
    let response = egress::trusted()?
        .post(format!("{base}/register"))
        .header("content-type", "application/json")
        .body(
            json!({
                "v": 1, "device": device, "platform": platform, "token": token,
                "sandbox": sandbox, "senders": senders, "at": at, "signature": signature,
            })
            .to_string(),
        )
        .send()
        .await
        .with_context(|| format!("cannot reach {base}"))?;
    let status = response.status();
    let answer: Value =
        serde_json::from_str(&response.text().await.unwrap_or_default()).unwrap_or(Value::Null);
    if !status.is_success() {
        bail!(
            "{base} refused: {}",
            answer["error"].as_str().unwrap_or(status.as_str())
        );
    }
    let handle = answer["handle"]
        .as_str()
        .filter(|h| h.len() == 32 && h.bytes().all(|b| b.is_ascii_hexdigit()))
        .context("the push service gave no handle")?;
    Ok(format!("{base}/{handle}"))
}
