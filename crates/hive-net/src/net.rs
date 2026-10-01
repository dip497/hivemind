//! The endpoint: this machine's device (§13.4). Never iroh's default presets, which would use n0's
//! relays and address lookup: nothing here reaches a server the person did not name. What it
//! reaches is the active network profile's (R16, `profile.rs`): its relays, and mDNS among the
//! devices on the same network. It always has a relay map, empty on the local network, so a
//! workspace on another network can add its host's relays while it runs.

use anyhow::Result;
use iroh::{
    endpoint::{presets, EndpointHooks, RelayMode},
    Endpoint, RelayMap, RelayUrl, SecretKey,
};
use iroh_mdns_address_lookup::MdnsAddressLookup;

/// The name hivemind devices announce themselves under on the local network, so they find each
/// other and no other iroh application's endpoints.
pub const MDNS_SERVICE: &str = "hivemind";

/// How this device is reached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reach {
    /// Relays, for devices elsewhere; none on the local network.
    pub relays: Vec<RelayUrl>,
    /// Whether devices on the same network find each other by mDNS.
    pub mdns: bool,
}

impl Reach {
    /// The local network: no relays, and devices here found by mDNS. The default.
    pub fn local() -> Self {
        Self {
            relays: vec![],
            mdns: true,
        }
    }
}

/// This device's endpoint, answering `alpns`.
pub async fn endpoint(key: SecretKey, reach: &Reach, alpns: Vec<Vec<u8>>) -> Result<Endpoint> {
    let nearby = local_lookup(&key, reach)?;
    bind(
        Endpoint::builder(presets::Minimal)
            .secret_key(key)
            .alpns(alpns),
        reach,
        nearby,
    )
    .await
}

/// This device's endpoint, answering `alpns` for the devices `gate` admits; and, when it looks on
/// the local network, what it finds there (the devices nearby and what each announces).
pub async fn endpoint_with(
    key: SecretKey,
    reach: &Reach,
    alpns: Vec<Vec<u8>>,
    gate: impl EndpointHooks + 'static,
) -> Result<(Endpoint, Option<MdnsAddressLookup>)> {
    let nearby = local_lookup(&key, reach)?;
    let endpoint = bind(
        Endpoint::builder(presets::Minimal)
            .secret_key(key)
            .alpns(alpns)
            .hooks(gate),
        reach,
        nearby.clone(),
    )
    .await?;
    Ok((endpoint, nearby))
}

/// mDNS among the devices on this network, when the network uses it.
fn local_lookup(key: &SecretKey, reach: &Reach) -> Result<Option<MdnsAddressLookup>> {
    if !reach.mdns {
        return Ok(None);
    }
    Ok(Some(
        MdnsAddressLookup::builder()
            .service_name(MDNS_SERVICE)
            .build(key.public())?,
    ))
}

async fn bind(
    builder: iroh::endpoint::Builder,
    reach: &Reach,
    nearby: Option<MdnsAddressLookup>,
) -> Result<Endpoint> {
    let mut builder = builder.relay_mode(RelayMode::Custom(RelayMap::from_iter(
        reach.relays.iter().cloned(),
    )));
    if let Some(lookup) = nearby {
        builder = builder.address_lookup(lookup);
    }
    Ok(builder.bind().await?)
}
