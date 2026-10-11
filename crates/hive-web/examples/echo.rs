//! A host that answers `hive/ws/1` by sending every frame back on the stream it came on: what the
//! test page (`www/echo.html`) measures against. It is reached through the relay named, alone.
//!
//!   cargo run --release --example echo -- --relay http://127.0.0.1:3340
//!
//! Prints its id, then serves until stopped.

use anyhow::Result;
use hive_net::{
    frames::{read_frame, write_frame},
    net::{self, Reach},
    ws,
};
use iroh::{
    endpoint::Connection,
    protocol::{AcceptError, ProtocolHandler, Router},
    RelayUrl, SecretKey,
};

#[derive(Debug, Clone)]
struct Echo;

impl ProtocolHandler for Echo {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        while let Ok((mut send, mut recv)) = connection.accept_bi().await {
            tokio::spawn(async move {
                // The first frame names the stream; the echo answers every name alike.
                let _name = read_frame(&mut recv).await?;
                while let Some(frame) = read_frame(&mut recv).await? {
                    write_frame(&mut send, &frame).await?;
                }
                send.finish()?;
                anyhow::Ok(())
            });
        }
        Ok(())
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut argv = std::env::args().skip(1);
    let relay: RelayUrl = match (argv.next().as_deref(), argv.next()) {
        (Some("--relay"), Some(url)) => url.parse()?,
        _ => anyhow::bail!("usage: echo --relay <url>"),
    };
    let reach = Reach {
        relays: vec![relay],
        lookup: None,
        mdns: false,
    };
    let endpoint = net::endpoint(SecretKey::generate(), &reach, vec![ws::ALPN.to_vec()]).await?;
    let router = Router::builder(endpoint).accept(ws::ALPN, Echo).spawn();
    router.endpoint().online().await;
    println!("{}", router.endpoint().id());
    tokio::signal::ctrl_c().await?;
    router.shutdown().await?;
    Ok(())
}
