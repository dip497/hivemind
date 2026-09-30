//! This machine's device key (spec/identity.md, "Where keys are kept"): `device.key` in its
//! identity directory holds the key's 32-byte Ed25519 seed in lowercase hex. The app (or `hive
//! host`) makes it; hive-net only reads it, so a machine is one device whichever of them runs.

use std::{
    env, fs,
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use iroh::SecretKey;

/// The device key kept in `dir`.
pub fn device_key(dir: &Path) -> Result<SecretKey> {
    let file = dir.join("device.key");
    if !file.exists() {
        bail!(
            "no device key at {} (the app makes it when it first starts)",
            file.display()
        );
    }
    seed_file(&file, "device key")
}

/// A `what` kept as its 32-byte Ed25519 seed in lowercase hex, as the app keeps its keys (a
/// network's admin key too).
pub fn seed_file(file: &Path, what: &str) -> Result<SecretKey> {
    let text =
        fs::read_to_string(file).with_context(|| format!("cannot read {}", file.display()))?;
    let seed = text.trim();
    if seed.len() != 64 || !seed.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        bail!("{} is not a {what}", file.display());
    }
    let mut bytes = [0u8; 32];
    hex::decode_to_slice(seed, &mut bytes)?;
    Ok(SecretKey::from_bytes(&bytes))
}

/// Where the app keeps this machine's keys: `identity` in its data folder.
pub fn app_identity_dir() -> Option<PathBuf> {
    let data = if cfg!(target_os = "macos") {
        PathBuf::from(env::var_os("HOME")?).join("Library/Application Support")
    } else if cfg!(windows) {
        PathBuf::from(env::var_os("APPDATA")?)
    } else {
        match env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
            Some(dir) => PathBuf::from(dir),
            None => PathBuf::from(env::var_os("HOME")?).join(".config"),
        }
    };
    Some(data.join("hivemind").join("identity"))
}
