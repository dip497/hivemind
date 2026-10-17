//! `hive/ping/1`: whether a device answers, how long it takes, and whether the answer came
//! directly or through a relay. The caller sends 16 random bytes and reads them back.

use std::time::{Duration, Instant};

use anyhow::{ensure, Result};
use iroh::{
    endpoint::Connection,
    protocol::{AcceptError, ProtocolHandler},
    Endpoint, EndpointAddr,
};

pub const ALPN: &[u8] = b"hive/ping/1";

/// Answers pings.
#[derive(Debug, Clone)]
pub struct Pong;

impl ProtocolHandler for Pong {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        let (mut send, mut recv) = connection.accept_bi().await?;
        let nonce = recv.read_to_end(16).await.map_err(AcceptError::from_err)?;
        send.write_all(&nonce)
            .await
            .map_err(AcceptError::from_err)?;
        send.finish().map_err(AcceptError::from_err)?;
        connection.closed().await;
        Ok(())
    }
}

/// A ping's answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Answer {
    pub rtt: Duration,
    /// Through a relay, rather than directly.
    pub relayed: bool,
}

/// Ping the device at `to`.
pub async fn ping(endpoint: &Endpoint, to: impl Into<EndpointAddr>) -> Result<Answer> {
    let started = Instant::now();
    let connection = endpoint.connect(to, ALPN).await?;
    let (mut send, mut recv) = connection.open_bi().await?;
    let nonce: [u8; 16] = rand::random();
    send.write_all(&nonce).await?;
    send.finish()?;
    let back = recv.read_to_end(16).await?;
    let rtt = started.elapsed();
    ensure!(back == nonce, "the answer was not what was sent");
    let relayed = connection
        .paths()
        .iter()
        .any(|p| p.is_selected() && p.is_relay());
    connection.close(0u32.into(), b"done");
    Ok(Answer { rtt, relayed })
}
