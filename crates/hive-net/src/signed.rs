//! What a device's signature says, and when it said it (spec/network-access.md, spec/push.md):
//! keys and signatures in hex, Ed25519 over the bytes each request's format defines, and the time a
//! signed request was made, which a server takes within ten minutes of its own clock. A device
//! signs; only a server checks (the `server` feature).

use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use iroh::PublicKey;
#[cfg(feature = "server")]
use iroh::Signature;

/// How far a signed request's time may be from the server's clock.
#[cfg(feature = "server")]
pub(crate) const CLOCK_SKEW_MS: u64 = 10 * 60 * 1000;

/// Now, in ms since the epoch.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Whether a request signed at `at` is near enough to `now` to be taken.
#[cfg(feature = "server")]
pub(crate) fn near(at: u64, now: u64) -> bool {
    now.abs_diff(at) <= CLOCK_SKEW_MS
}

/// The key `hex_key` names.
pub(crate) fn key_of(hex_key: &str) -> Result<PublicKey> {
    let mut bytes = [0u8; 32];
    hex::decode_to_slice(hex_key, &mut bytes).with_context(|| format!("{hex_key} is not a key"))?;
    PublicKey::from_bytes(&bytes).with_context(|| format!("{hex_key} is not a key"))
}

#[cfg(feature = "server")]
fn signature_of(hex_sig: &str) -> Result<Signature> {
    let mut bytes = [0u8; 64];
    hex::decode_to_slice(hex_sig, &mut bytes).context("a signature is 64 bytes in hex")?;
    Ok(Signature::from_bytes(&bytes))
}

/// That `signature`, in hex, is `key`'s over `bytes`.
#[cfg(feature = "server")]
pub(crate) fn verify(key: &PublicKey, bytes: &[u8], signature: &str) -> Result<()> {
    key.verify(bytes, &signature_of(signature)?)
        .map_err(|_| anyhow::anyhow!("the signature does not verify"))
}
