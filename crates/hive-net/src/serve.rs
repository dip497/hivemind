//! The server roles (§13.4), which anyone can run for their own devices: the relay, which carries
//! traffic between devices that cannot reach each other directly, admitting the devices the
//! network's access role allows when it runs beside one (`access.rs`). It serves plain HTTP; TLS
//! for a relay on the internet comes with R13.

use std::{net::SocketAddr, sync::Arc};

use anyhow::Result;
use iroh::RelayUrl;
use iroh_relay::server::{RelayConfig, Server, ServerConfig};

use crate::access::Service;

/// A relay, serving on `addr`; it stops when dropped.
pub struct Relay {
    server: Server,
}

impl Relay {
    /// A relay on `addr`, for every device, or for those `access` allows.
    pub async fn spawn(addr: SocketAddr, access: Option<Service>) -> Result<Self> {
        let mut config = ServerConfig::default();
        let mut relay = RelayConfig::new(addr);
        if let Some(access) = access {
            relay.access = Arc::new(access);
        }
        config.relay = Some(relay);
        Ok(Self {
            server: Server::spawn(config).await?,
        })
    }

    /// The URL it serves on, with the address it is bound to (devices on other machines reach it
    /// by this machine's own address).
    pub fn url(&self) -> RelayUrl {
        let addr = self.server.http_addr().expect("a relay serves HTTP");
        format!("http://{addr}")
            .parse()
            .expect("an address is a URL's host")
    }

    /// Serve until the server stops.
    pub async fn run(mut self) -> Result<()> {
        self.server.join().await??;
        Ok(())
    }
}
