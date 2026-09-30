//! The server roles (§13.4), which anyone can run for their own devices: for now the relay, which
//! carries traffic between devices that cannot reach each other directly. It serves plain HTTP;
//! TLS comes with the network profiles that name it (R16).

use std::net::SocketAddr;

use anyhow::Result;
use iroh::RelayUrl;
use iroh_relay::server::{RelayConfig, Server, ServerConfig};

/// A relay, serving on `addr`; it stops when dropped.
pub struct Relay {
    server: Server,
}

impl Relay {
    pub async fn spawn(addr: SocketAddr) -> Result<Self> {
        let mut config = ServerConfig::default();
        config.relay = Some(RelayConfig::new(addr));
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
