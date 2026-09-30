//! `hive-net`: this machine's device on the network (R10).
//!
//!   hive-net id                    print this device's id (its EndpointId)
//!   hive-net run                   answer pings until stopped
//!   hive-net ping <id>             ping a device by its id
//!   hive-net serve --relay         run a relay for your devices
//!
//! Options: `--identity <dir>` (default: the app's), `--relay <url>` (repeatable: reach devices
//! through these relays rather than on the local network), `--addr <ip:port>` (ping: where the
//! device is, when mDNS cannot find it), `--bind <ip:port>` (serve; default [::]:3340).

use std::{net::SocketAddr, path::PathBuf, process::ExitCode, str::FromStr, time::Duration};

use anyhow::{bail, Context, Result};
use hive_net::{
    key,
    net::{self, Reach},
    ping::{self, Pong},
    serve::Relay,
};
use iroh::{protocol::Router, EndpointAddr, EndpointId, RelayUrl, TransportAddr};

/// How long a ping waits for its answer.
const PING_TIMEOUT: Duration = Duration::from_secs(10);

const USAGE: &str = "usage: hive-net id | run | ping <id> | serve --relay  [--identity <dir>] [--relay <url>]... [--addr <ip:port>]... [--bind <ip:port>]";

#[derive(Default)]
struct Args {
    command: String,
    target: Option<String>,
    identity: Option<PathBuf>,
    relays: Vec<RelayUrl>,
    addrs: Vec<SocketAddr>,
    bind: Option<SocketAddr>,
    relay_role: bool,
}

fn parse(mut argv: impl Iterator<Item = String>) -> Result<Args> {
    let mut args = Args::default();
    let value = |argv: &mut dyn Iterator<Item = String>, flag: &str| {
        argv.next().with_context(|| format!("{flag} needs a value"))
    };
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--identity" => args.identity = Some(value(&mut argv, &arg)?.into()),
            "--relay" if args.command == "serve" => args.relay_role = true,
            "--relay" => args
                .relays
                .push(RelayUrl::from_str(&value(&mut argv, &arg)?)?),
            "--addr" => args.addrs.push(value(&mut argv, &arg)?.parse()?),
            "--bind" => args.bind = Some(value(&mut argv, &arg)?.parse()?),
            flag if flag.starts_with("--") => bail!("unknown option {flag}\n{USAGE}"),
            _ if args.command.is_empty() => args.command = arg,
            _ if args.target.is_none() => args.target = Some(arg),
            _ => bail!("unexpected {arg}\n{USAGE}"),
        }
    }
    Ok(args)
}

impl Args {
    fn reach(&self) -> Reach {
        if self.relays.is_empty() {
            Reach::Local
        } else {
            Reach::Relays(self.relays.clone())
        }
    }

    fn device_key(&self) -> Result<iroh::SecretKey> {
        let dir = match &self.identity {
            Some(dir) => dir.clone(),
            None => key::app_identity_dir()
                .context("cannot tell where the app keeps its keys: give --identity")?,
        };
        key::device_key(&dir)
    }
}

async fn run(args: Args) -> Result<()> {
    match args.command.as_str() {
        "id" => println!("{}", args.device_key()?.public()),
        "run" => {
            let endpoint =
                net::endpoint(args.device_key()?, &args.reach(), vec![ping::ALPN.to_vec()]).await?;
            let router = Router::builder(endpoint).accept(ping::ALPN, Pong).spawn();
            let endpoint = router.endpoint();
            if !args.relays.is_empty() {
                endpoint.online().await;
            }
            println!("{}", endpoint.id());
            for addr in endpoint.addr().addrs {
                match addr {
                    TransportAddr::Ip(ip) => println!("  direct {ip}"),
                    TransportAddr::Relay(url) => println!("  relay {url}"),
                    _ => {}
                }
            }
            tokio::signal::ctrl_c().await?;
            router.shutdown().await?;
        }
        "ping" => {
            let target = args.target.as_deref().context(USAGE)?;
            let id = EndpointId::from_str(target)
                .with_context(|| format!("{target} is not a device id"))?;
            let mut to = EndpointAddr::new(id);
            for addr in &args.addrs {
                to = to.with_ip_addr(*addr);
            }
            for url in &args.relays {
                to = to.with_relay_url(url.clone());
            }
            let endpoint = net::endpoint(args.device_key()?, &args.reach(), vec![]).await?;
            let answer = tokio::time::timeout(PING_TIMEOUT, ping::ping(&endpoint, to))
                .await
                .with_context(|| {
                    format!("no answer from {id} in {} s", PING_TIMEOUT.as_secs())
                })??;
            let how = if answer.relayed {
                "through a relay"
            } else {
                "directly"
            };
            println!("{id} answered in {} ms, {how}", answer.rtt.as_millis());
            endpoint.close().await;
        }
        "serve" if args.relay_role => {
            let relay =
                Relay::spawn(args.bind.unwrap_or_else(|| "[::]:3340".parse().unwrap())).await?;
            println!("relay serving on {}", relay.url());
            relay.run().await?;
        }
        _ => bail!("{USAGE}"),
    }
    Ok(())
}

#[tokio::main]
async fn main() -> ExitCode {
    match parse(std::env::args().skip(1)) {
        Ok(args) => match run(args).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("hive-net: {e:#}");
                ExitCode::FAILURE
            }
        },
        Err(e) => {
            eprintln!("hive-net: {e:#}");
            ExitCode::from(2)
        }
    }
}
