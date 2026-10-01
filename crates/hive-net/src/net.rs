//! The endpoint: this machine's device (§13.4). Never iroh's default presets, which would use n0's
//! relays and address lookup: nothing here reaches a server the person did not name. What it
//! reaches is the active network profile's (R16, `profile.rs`): its relays, its lookup server, and
//! mDNS among the devices on the same network. It always has a relay map, empty on the local
//! network, so a workspace on another network can add its host's relays while it runs.

use std::str::FromStr;

use anyhow::{Context, Result};
use iroh::{
    address_lookup::{PkarrPublisher, PkarrResolver},
    endpoint::{presets, Builder, EndpointHooks, RelayMode},
    tls::CaTlsConfig,
    Endpoint, EndpointAddr, EndpointId, RelayMap, RelayUrl, SecretKey,
};
use iroh_mdns_address_lookup::MdnsAddressLookup;
use url::Url;

/// The name hivemind devices announce themselves under on the local network, so they find each
/// other and no other iroh application's endpoints.
pub const MDNS_SERVICE: &str = "hivemind";

/// How this device is reached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reach {
    /// Relays, for devices elsewhere; none on the local network.
    pub relays: Vec<RelayUrl>,
    /// The network's lookup server (pkarr over HTTP, §12.2): where this device says which relay it
    /// is reached through, signed by its key, and finds other devices by their id alone.
    pub lookup: Option<Url>,
    /// Whether devices on the same network find each other by mDNS.
    pub mdns: bool,
}

impl Reach {
    /// The local network: no relays, no lookup server, and devices here found by mDNS. The
    /// default.
    pub fn local() -> Self {
        Self {
            relays: vec![],
            lookup: None,
            mdns: true,
        }
    }
}

/// The certificate authorities this device trusts for the network's servers (relays, the lookup
/// server): the web's public ones, built in, and those this machine trusts (a company's own; or
/// the ones `SSL_CERT_FILE` names).
pub fn trusted() -> CaTlsConfig {
    CaTlsConfig::embedded().with_extra_roots(rustls_native_certs::load_native_certs().certs)
}

/// An endpoint of this device, on `reach`'s relays and lookup server; mDNS is added by the caller,
/// which keeps hold of it.
pub fn builder(key: SecretKey, reach: &Reach) -> Builder {
    let mut builder = Endpoint::builder(presets::Minimal)
        .secret_key(key)
        .ca_tls_config(trusted())
        .relay_mode(RelayMode::Custom(RelayMap::from_iter(
            reach.relays.iter().cloned(),
        )));
    if let Some(lookup) = &reach.lookup {
        builder = builder
            .address_lookup(PkarrPublisher::builder(lookup.clone()))
            .address_lookup(PkarrResolver::builder(lookup.clone()));
    }
    builder
}

/// This device's endpoint, answering `alpns`.
pub async fn endpoint(key: SecretKey, reach: &Reach, alpns: Vec<Vec<u8>>) -> Result<Endpoint> {
    let nearby = local_lookup(&key, reach)?;
    bind(builder(key, reach).alpns(alpns), nearby).await
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
    let endpoint = bind(builder(key, reach).alpns(alpns).hooks(gate), nearby.clone()).await?;
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

async fn bind(mut builder: Builder, nearby: Option<MdnsAddressLookup>) -> Result<Endpoint> {
    if let Some(lookup) = nearby {
        builder = builder.address_lookup(lookup);
    }
    Ok(builder.bind().await?)
}

/// The device `peer`, where it says it is reached: its direct addresses, and its relay.
pub fn addr_of(peer: &str, addrs: &[String], relay: &Option<String>) -> Result<EndpointAddr> {
    let id = EndpointId::from_str(peer).with_context(|| format!("{peer} is not a device id"))?;
    let mut addr = EndpointAddr::new(id);
    for a in addrs {
        addr = addr.with_ip_addr(
            a.parse()
                .with_context(|| format!("{a} is not an address"))?,
        );
    }
    if let Some(url) = relay {
        addr = addr.with_relay_url(url.parse()?);
    }
    Ok(addr)
}
