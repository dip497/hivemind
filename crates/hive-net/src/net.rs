//! The endpoint: this machine's device, reached one of two ways (§13.4). Never iroh's default
//! presets, which would use n0's relays and address lookup: nothing here reaches a server the
//! person did not name. Network profiles (R16) will choose between these and add a lookup server.

use anyhow::Result;
use iroh::{
    endpoint::{presets, EndpointHooks, RelayMode},
    Endpoint, RelayUrl, SecretKey,
};
use iroh_mdns_address_lookup::MdnsAddressLookup;

/// The name hivemind devices announce themselves under on the local network, so they find each
/// other and no other iroh application's endpoints.
pub const MDNS_SERVICE: &str = "hivemind";

/// How this device is reached.
#[derive(Debug, Clone)]
pub enum Reach {
    /// The local network: no relays, and devices here found by mDNS. The default.
    Local,
    /// Through these relays, for devices elsewhere.
    Relays(Vec<RelayUrl>),
}

/// This device's endpoint, answering `alpns`.
pub async fn endpoint(key: SecretKey, reach: &Reach, alpns: Vec<Vec<u8>>) -> Result<Endpoint> {
    bind(
        Endpoint::builder(presets::Minimal)
            .secret_key(key)
            .alpns(alpns),
        reach,
    )
    .await
}

/// This device's endpoint, answering `alpns` for the devices `gate` admits.
pub async fn endpoint_with(
    key: SecretKey,
    reach: &Reach,
    alpns: Vec<Vec<u8>>,
    gate: impl EndpointHooks + 'static,
) -> Result<Endpoint> {
    bind(
        Endpoint::builder(presets::Minimal)
            .secret_key(key)
            .alpns(alpns)
            .hooks(gate),
        reach,
    )
    .await
}

async fn bind(builder: iroh::endpoint::Builder, reach: &Reach) -> Result<Endpoint> {
    let builder = match reach {
        Reach::Local => builder
            .relay_mode(RelayMode::Disabled)
            .address_lookup(MdnsAddressLookup::builder().service_name(MDNS_SERVICE)),
        Reach::Relays(urls) => builder.relay_mode(RelayMode::custom(urls.iter().cloned())),
    };
    Ok(builder.bind().await?)
}
