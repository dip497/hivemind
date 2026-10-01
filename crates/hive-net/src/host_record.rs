//! Host records (§5.8, spec/host-record.md): which device hosts a workspace now. A record is a
//! pkarr packet signed by the workspace key (R3: derived from its owner's person key, so any of
//! the owner's devices can sign one and nobody else can), holding one TXT record `_hive` =
//! `host=<device id>;seq=<n>`, filed at the network's lookup server under the workspace's public
//! key. `seq` grows by one at each move; the server keeps the newest packet. A reader checks the
//! signature itself.

use std::str::FromStr;

use anyhow::{bail, Context, Result};
use iroh::{EndpointId, PublicKey, SecretKey};
use iroh_dns::pkarr::SignedPacket;
use serde::Serialize;
use url::Url;

/// The TXT record's name, under the workspace's key.
pub const NAME: &str = "_hive";
/// How long a resolver may cache it, in seconds.
const TTL: u32 = 30;

/// Which device hosts a workspace, and how many moves it took to get there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct HostRecord {
    pub host: EndpointId,
    pub seq: u64,
}

impl HostRecord {
    fn text(&self) -> String {
        format!("host={};seq={}", self.host, self.seq)
    }

    fn parse(text: &str) -> Result<Self> {
        let mut host = None;
        let mut seq = None;
        for part in text.split(';') {
            match part.split_once('=') {
                Some(("host", id)) => host = Some(EndpointId::from_str(id)?),
                Some(("seq", n)) => seq = Some(n.parse()?),
                _ => {}
            }
        }
        Ok(Self {
            host: host.context("a host record names its host")?,
            seq: seq.context("a host record has a seq")?,
        })
    }

    /// The record, signed by `workspace`'s key.
    pub fn sign(&self, workspace: &SecretKey) -> Result<SignedPacket> {
        Ok(SignedPacket::from_txt_strings(
            workspace,
            NAME,
            [self.text()],
            TTL,
        )?)
    }

    /// The record a packet holds; the packet's signature was checked when it was read.
    pub fn of(packet: &SignedPacket) -> Result<Self> {
        match packet.txt_records(NAME).as_slice() {
            [one] => Self::parse(one),
            [] => bail!("the packet holds no host record"),
            _ => bail!("the packet holds more than one host record"),
        }
    }
}

/// Where the lookup server `lookup` files what `key` signs.
fn at(lookup: &Url, key: &PublicKey) -> String {
    format!("{}/{}", lookup.as_str().trim_end_matches('/'), key.to_z32())
}

/// File `record`, signed by `workspace`'s key, at the lookup server `lookup`.
pub async fn publish(lookup: &Url, workspace: &SecretKey, record: HostRecord) -> Result<()> {
    let packet = record.sign(workspace)?;
    let response = crate::access::client::http()?
        .put(at(lookup, &workspace.public()))
        .body(packet.to_relay_payload())
        .send()
        .await
        .with_context(|| format!("cannot reach {lookup}"))?;
    if !response.status().is_success() {
        bail!("{lookup} did not take the record: {}", response.status());
    }
    Ok(())
}

/// The host record of the workspace whose key is `workspace`, as the lookup server `lookup` has
/// it, its signature checked; none when it has none.
pub async fn resolve(lookup: &Url, workspace: PublicKey) -> Result<Option<HostRecord>> {
    let response = crate::access::client::http()?
        .get(at(lookup, &workspace))
        .send()
        .await
        .with_context(|| format!("cannot reach {lookup}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        bail!("{lookup} answered {}", response.status());
    }
    let packet = SignedPacket::from_relay_payload(&workspace, &response.bytes().await?)
        .context("the record is not signed by the workspace's key")?;
    Ok(Some(HostRecord::of(&packet)?))
}
