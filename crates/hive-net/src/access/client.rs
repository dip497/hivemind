//! A device asking a network's access service, as the app and the admin's command line do.

use anyhow::{bail, Context, Result};
use iroh::{PublicKey, SecretKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{leading_zero_bits, redeem_bytes, register_bytes, revoke_bytes, Voucher};
use crate::{egress, signed::now_ms};

fn at(access: &str, path: &str) -> String {
    format!("{}{path}", access.trim_end_matches('/'))
}

async fn post(access: &str, path: &str, body: Value) -> Result<()> {
    let response = egress::trusted()?
        .post(at(access, path))
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .with_context(|| format!("cannot reach {access}"))?;
    if response.status().is_success() {
        return Ok(());
    }
    let text = response.text().await.unwrap_or_default();
    let why = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v["error"].as_str().map(str::to_string))
        .unwrap_or(text);
    bail!("{access} refused: {why}")
}

/// Give the service a voucher that names its device.
pub async fn vouch(access: &str, voucher: &Voucher) -> Result<()> {
    post(access, "/vouch", serde_json::to_value(voucher)?).await
}

/// Redeem a voucher that names no device, as `key`'s device.
pub async fn redeem(access: &str, voucher: &Voucher, key: &SecretKey) -> Result<()> {
    let device = key.public();
    let proof = hex::encode(key.sign(&redeem_bytes(&voucher.nonce, &device)?).to_bytes());
    post(
        access,
        "/redeem",
        json!({ "voucher": voucher, "device": device.to_string(), "proof": proof }),
    )
    .await
}

/// Register `key`'s device on an `open-pow` network: the work it asks for, then the request.
pub async fn register(access: &str, key: &SecretKey) -> Result<()> {
    let bits: Value = serde_json::from_str(
        &egress::trusted()?
            .get(at(access, "/pow"))
            .send()
            .await
            .with_context(|| format!("cannot reach {access}"))?
            .text()
            .await?,
    )?;
    let bits = bits["bits"]
        .as_u64()
        .context("the service did not say how much work")? as u32;
    let device = key.public();
    let at_ms = now_ms();
    let nonce = (0u64..)
        .find(|n| leading_zero_bits(&Sha256::digest(register_bytes(&device, at_ms, *n))) >= bits)
        .expect("some nonce does the work");
    let signature = hex::encode(key.sign(&register_bytes(&device, at_ms, nonce)).to_bytes());
    post(access, "/register", json!({ "device": device.to_string(), "at": at_ms, "nonce": nonce, "signature": signature })).await
}

/// Take `device`'s admission back, as `by`.
pub async fn revoke(access: &str, device: &PublicKey, by: &SecretKey) -> Result<()> {
    let at_ms = now_ms();
    let signature = hex::encode(
        by.sign(&revoke_bytes(&by.public(), device, at_ms))
            .to_bytes(),
    );
    post(access, "/revoke", json!({ "device": device.to_string(), "by": by.public().to_string(), "at": at_ms, "signature": signature })).await
}
