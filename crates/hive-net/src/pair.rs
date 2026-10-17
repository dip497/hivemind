//! `hive/pair/1` (design §7): first contact. Someone new presents what they were given (an invite's
//! secret, with their device certificate and profile, or a pairing code's proof) and the device
//! asked answers (a role, the person, or no). Open to any device: the asked device's main decides,
//! and the connection closes after the answer.

use anyhow::{Context, Result};
use iroh::{Endpoint, EndpointAddr};
use serde_json::Value;

use crate::frames::{read_frame, write_frame};

pub const ALPN: &[u8] = b"hive/pair/1";

/// Ask the device at `addr` with `hello`, from `endpoint`: one request on `hive/pair/1`, and the
/// answer it gives.
pub async fn ask(endpoint: &Endpoint, addr: EndpointAddr, hello: &Value) -> Result<Value> {
    let connection = endpoint.connect(addr, ALPN).await?;
    let (mut send, mut recv) = connection.open_bi().await?;
    write_frame(&mut send, serde_json::to_string(hello)?.as_bytes()).await?;
    send.finish()?;
    let reply = read_frame(&mut recv)
        .await?
        .context("the device closed without answering")?;
    connection.close(0u32.into(), b"done");
    Ok(serde_json::from_slice(&reply)?)
}
