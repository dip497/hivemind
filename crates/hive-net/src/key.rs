//! This machine's keys (spec/identity.md, "Where keys are kept"): `device.key` and `person.key`
//! in its identity directory hold each key's 32-byte Ed25519 seed in lowercase hex. The app (or
//! `hive host`) makes them; hive-net only reads them, so a machine is one device whichever of them
//! runs. A workspace's key is derived from its owner's person key and its id.

use std::{
    env, fs,
    path::{Path, PathBuf},
};

use anyhow::{bail, ensure, Context, Result};
use hkdf::Hkdf;
use iroh::SecretKey;
use sha2::Sha256;

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

/// The person key kept in `dir`: whose this device is.
pub fn person_key(dir: &Path) -> Result<SecretKey> {
    let file = dir.join("person.key");
    if !file.exists() {
        bail!(
            "no person key at {} (the app makes it when it first starts)",
            file.display()
        );
    }
    seed_file(&file, "person key")
}

/// The key of workspace `workspace_id` owned by the person whose key is `person`: HKDF-SHA256 of
/// the person's seed, no salt, with the info `hive-workspace` and then the workspace's id, so
/// every one of the owner's devices derives the same and nobody else can (spec/identity.md).
pub fn workspace_key(person: &SecretKey, workspace_id: &str) -> Result<SecretKey> {
    ensure!(!workspace_id.is_empty(), "a workspace id is not empty");
    let mut seed = [0u8; 32];
    Hkdf::<Sha256>::new(None, &person.to_bytes())
        .expand(
            &[b"hive-workspace", workspace_id.as_bytes()].concat(),
            &mut seed,
        )
        .map_err(|_| anyhow::anyhow!("a workspace key is 32 bytes"))?;
    Ok(SecretKey::from_bytes(&seed))
}

/// Where a server keeps its network's admin key, in its data folder.
pub const ADMIN_KEY: &str = "admin.key";

/// The network's admin key kept in `dir`, and whether it was made just now: a server that runs
/// the access role for its own network makes one the first time (`hive-net serve --all`). It
/// signs the network's profile and its enrolments, so it is kept like the others (0600).
pub fn admin_key(dir: &Path) -> Result<(SecretKey, bool)> {
    kept_or_made(dir, ADMIN_KEY, "network's admin key")
}

/// The `what` kept in `dir` as `name`, and whether it was made just now: made from 32 random
/// bytes the first time, and kept as the app keeps its keys (`dir` 0700, the file 0600).
pub fn kept_or_made(dir: &Path, name: &str, what: &str) -> Result<(SecretKey, bool)> {
    let file = dir.join(name);
    if file.exists() {
        return Ok((seed_file(&file, what)?, false));
    }
    let mut folder = fs::DirBuilder::new();
    folder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut folder, 0o700);
    folder
        .create(dir)
        .with_context(|| format!("cannot make {}", dir.display()))?;
    let key = SecretKey::from_bytes(&rand::random::<[u8; 32]>());
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    std::io::Write::write_all(
        &mut options
            .open(&file)
            .with_context(|| format!("cannot write {}", file.display()))?,
        format!("{}\n", hex::encode(key.to_bytes())).as_bytes(),
    )?;
    Ok((key, true))
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

/// Where this user's applications keep their data on this machine.
pub fn data_dir() -> Option<PathBuf> {
    Some(if cfg!(target_os = "macos") {
        PathBuf::from(env::var_os("HOME")?).join("Library/Application Support")
    } else if cfg!(windows) {
        PathBuf::from(env::var_os("APPDATA")?)
    } else {
        match env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
            Some(dir) => PathBuf::from(dir),
            None => PathBuf::from(env::var_os("HOME")?).join(".config"),
        }
    })
}

/// Where the app keeps this machine's keys: `identity` in its data folder.
pub fn app_identity_dir() -> Option<PathBuf> {
    Some(data_dir()?.join("hivemind").join("identity"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(hex_seed: &str) -> SecretKey {
        let mut bytes = [0u8; 32];
        hex::decode_to_slice(hex_seed, &mut bytes).unwrap();
        SecretKey::from_bytes(&bytes)
    }

    /// The workspace keys the conformance cases give, from the person key and the workspace id:
    /// the same as the app derives (packages/workspace-host/src/identity.ts).
    #[test]
    fn workspace_keys_are_the_conformance_cases() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../../conformance/identity.json")).unwrap();
        let cases = cases["workspaceKey"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let person = seed(case["personSeed"].as_str().unwrap());
            let key = workspace_key(&person, case["workspaceId"].as_str().unwrap()).unwrap();
            assert_eq!(hex::encode(key.to_bytes()), case["seed"].as_str().unwrap());
            assert_eq!(key.public().to_string(), case["id"].as_str().unwrap());
        }
    }
}
