//! What the phone is (spec/identity.md): its device key, made the first time, and the certificate
//! the app it paired with signed for it, naming it as the person's. A phone keeps no person key
//! (spec/pairing.md 0.3); it only reads certificates, never makes one.

use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use iroh::{PublicKey, SecretKey, Signature};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// "Device `device` is person `person`'s", signed by the person key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCertificate {
    pub v: u8,
    pub person: String,
    pub device: String,
    /// When it was signed, ms since the epoch.
    pub issued_at: u64,
    pub signature: String,
}

/// The largest whole number every implementation reads exactly (JavaScript's safe integers).
const MAX_SAFE: u64 = (1 << 53) - 1;

pub(crate) fn is_hex(text: &str, len: usize) -> bool {
    text.len() == len && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

impl DeviceCertificate {
    /// What it signs: its tag, the person's key, the device's key, and when (u64, big-endian ms).
    fn signed(&self) -> Option<Vec<u8>> {
        let mut bytes = b"hive/device-certificate/1\n".to_vec();
        bytes.extend(hex::decode(&self.person).ok()?);
        bytes.extend(hex::decode(&self.device).ok()?);
        bytes.extend(self.issued_at.to_be_bytes());
        Some(bytes)
    }

    /// Whether each field has its form and the signature is the person key's over what it signs.
    pub fn verifies(&self) -> bool {
        if self.v != 1
            || !is_hex(&self.person, 64)
            || !is_hex(&self.device, 64)
            || self.issued_at > MAX_SAFE
            || !is_hex(&self.signature, 128)
        {
            return false;
        }
        let (Some(bytes), Ok(person), Ok(signature)) = (
            self.signed(),
            hex::decode(&self.person),
            hex::decode(&self.signature),
        ) else {
            return false;
        };
        let (Ok(person), Ok(signature)) = (
            <[u8; 32]>::try_from(person.as_slice()),
            <[u8; 64]>::try_from(signature.as_slice()),
        ) else {
            return false;
        };
        PublicKey::from_bytes(&person).is_ok_and(|key| {
            key.verify(&bytes, &Signature::from_bytes(&signature))
                .is_ok()
        })
    }

    /// The certificate in `value`, when it is one that verifies.
    pub fn verified(value: &Value) -> Option<Self> {
        let cert: Self = serde_json::from_value(value.clone()).ok()?;
        cert.verifies().then_some(cert)
    }
}

/// This phone's identity directory: its device key (`device.key`) and, once paired, the
/// certificate it was given (`device.cert`), kept as the app keeps its own.
pub struct Identity {
    dir: PathBuf,
    key: SecretKey,
}

impl Identity {
    /// The phone whose keys are in `dir`: its device key is made the first time.
    pub fn open(dir: &Path) -> Result<Self> {
        let (key, _) = hive_net::key::kept_or_made(dir, "device.key", "device key")?;
        Ok(Self {
            dir: dir.to_path_buf(),
            key,
        })
    }

    /// Its device key, which its endpoint is.
    pub fn key(&self) -> &SecretKey {
        &self.key
    }

    /// Its id: its device key's public half, in lowercase hex.
    pub fn id(&self) -> String {
        self.key.public().to_string()
    }

    pub(crate) fn dir(&self) -> &Path {
        &self.dir
    }

    /// The certificate it was given when it paired, while it verifies and names this phone.
    pub fn certificate(&self) -> Option<DeviceCertificate> {
        let text = fs::read_to_string(self.dir.join("device.cert")).ok()?;
        let cert = DeviceCertificate::verified(&serde_json::from_str(&text).ok()?)?;
        (cert.device == self.id()).then_some(cert)
    }

    /// Keep `cert` as this phone's certificate.
    pub(crate) fn certify(&self, cert: &DeviceCertificate) -> Result<()> {
        write_private(
            &self.dir.join("device.cert"),
            &format!("{}\n", serde_json::to_string(cert)?),
        )
    }
}

/// Write `text` to `file` whole, readable by this user alone.
pub(crate) fn write_private(file: &Path, text: &str) -> Result<()> {
    let tmp = file.with_extension(format!("{}.tmp", std::process::id()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    std::io::Write::write_all(
        &mut options
            .open(&tmp)
            .with_context(|| format!("cannot write {}", tmp.display()))?,
        text.as_bytes(),
    )?;
    fs::rename(&tmp, file).with_context(|| format!("cannot write {}", file.display()))
}
