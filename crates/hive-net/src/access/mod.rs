//! The access role (R16, spec/network-access.md): who may use a network's relays. A device is
//! allowed while it is enrolled (by the admin, or by an enrolled device), registered (an
//! `open-pow` network: it proved its key and did a little work) or visiting (until the voucher
//! that admitted it expires). Every change is signed, so there are no accounts; what is allowed
//! is kept in one file, and nothing else is. A relay beside it asks it about each device that
//! connects (`AccessControl`); a relay elsewhere asks over HTTP (`GET /allowed/<id>`, `Remote`),
//! as a stock relay can. `serve.rs` serves its requests under `/access`.
//!
//! Its parts: what a device and the role agree on (vouchers and what each request signs, here), a
//! device's side (`client`), and the role itself (`service`), which only a server links.

use anyhow::{Context, Result};
use iroh::{PublicKey, SecretKey};
use serde::{Deserialize, Serialize};

use crate::signed::key_of;

pub mod client;
#[cfg(feature = "server")]
mod service;
#[cfg(feature = "server")]
pub use service::{Remote, Service, REMEMBER, REMEMBER_NO};

const VOUCHER: &[u8] = b"hive/voucher/1\n";
const REDEEM: &[u8] = b"hive/redeem/1\n";
const REGISTER: &[u8] = b"hive/register/1\n";
const REVOKE: &[u8] = b"hive/revoke/1\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// For good, until revoked.
    Enrol,
    /// Until the voucher expires.
    Visit,
}

/// A signed, time-limited, counted admission.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Voucher {
    pub v: u32,
    pub kind: Kind,
    pub by: String,
    pub device: Option<String>,
    pub nonce: String,
    pub expires: u64,
    pub uses: u32,
    pub signature: String,
}

impl Voucher {
    /// A voucher of `kind`, signed by `by`, for `device` (none: whoever redeems it), until
    /// `expires`, redeemed at most `uses` times.
    pub fn new(
        kind: Kind,
        by: &SecretKey,
        device: Option<PublicKey>,
        expires: u64,
        uses: u32,
    ) -> Self {
        let mut v = Voucher {
            v: 1,
            kind,
            by: by.public().to_string(),
            device: device.map(|d| d.to_string()),
            nonce: hex::encode(rand::random::<[u8; 16]>()),
            expires,
            uses,
            signature: String::new(),
        };
        v.signature = hex::encode(
            by.sign(&v.bytes().expect("a voucher made here is well formed"))
                .to_bytes(),
        );
        v
    }

    fn bytes(&self) -> Result<Vec<u8>> {
        let by = key_of(&self.by)?;
        let device = match &self.device {
            Some(d) => *key_of(d)?.as_bytes(),
            None => [0u8; 32],
        };
        let mut nonce = [0u8; 16];
        hex::decode_to_slice(&self.nonce, &mut nonce).context("a nonce is 16 bytes in hex")?;
        let mut out = VOUCHER.to_vec();
        out.push(match self.kind {
            Kind::Enrol => 0,
            Kind::Visit => 1,
        });
        out.extend_from_slice(by.as_bytes());
        out.extend_from_slice(&device);
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&self.expires.to_be_bytes());
        out.extend_from_slice(&self.uses.to_be_bytes());
        Ok(out)
    }
}

fn redeem_bytes(nonce: &str, device: &PublicKey) -> Result<Vec<u8>> {
    let mut n = [0u8; 16];
    hex::decode_to_slice(nonce, &mut n).context("a nonce is 16 bytes in hex")?;
    Ok([REDEEM, &n, device.as_bytes()].concat())
}

fn register_bytes(device: &PublicKey, at: u64, nonce: u64) -> Vec<u8> {
    [
        REGISTER,
        device.as_bytes(),
        &at.to_be_bytes(),
        &nonce.to_be_bytes(),
    ]
    .concat()
}

fn revoke_bytes(by: &PublicKey, device: &PublicKey, at: u64) -> Vec<u8> {
    [REVOKE, by.as_bytes(), device.as_bytes(), &at.to_be_bytes()].concat()
}

fn leading_zero_bits(hash: &[u8]) -> u32 {
    let mut bits = 0;
    for b in hash {
        if *b == 0 {
            bits += 8;
        } else {
            return bits + b.leading_zeros();
        }
    }
    bits
}
