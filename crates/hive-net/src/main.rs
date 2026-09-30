//! `hive-net`: this machine's device on the network (R10, R16).
//!
//!   hive-net id                    print this device's id (its EndpointId)
//!   hive-net run                   answer pings until stopped
//!   hive-net ping <id>             ping a device by its id
//!   hive-net serve --relay         run a relay for your devices
//!   hive-net daemon --socket <path>  the app's network (`daemon.rs`); main starts it
//!   hive-net doctor                whether the network's servers answer, as JSON
//!   hive-net profile verify <profile>        the profile, if it is one this may use, as JSON
//!   hive-net profile sign <file> --admin <key>  sign a profile's text as its network's admin
//!   hive-net profile link <file>   the link that carries a signed profile
//!
//! Options: `--identity <dir>` (default: the app's), `--profile <profile>` (the network: `local`,
//! the default, `hosted`, a signed profile's file or its link), `--relay <url>` (repeatable:
//! reach devices through these relays only), `--addr <ip:port>` (ping: where the device is, when
//! mDNS cannot find it), `--bind <ip:port>` (serve; default [::]:3340).

use std::{net::SocketAddr, path::PathBuf, process::ExitCode, str::FromStr, time::Duration};

use anyhow::{bail, Context, Result};
use hive_net::{
    key,
    net::{self, Reach},
    ping::{self, Pong},
    profile,
    serve::Relay,
};
use iroh::{protocol::Router, EndpointAddr, EndpointId, RelayUrl, TransportAddr};

/// How long a ping waits for its answer.
const PING_TIMEOUT: Duration = Duration::from_secs(10);

const USAGE: &str = "usage: hive-net id | run | ping <id> | serve --relay | daemon --socket <path> | doctor | profile verify <profile> | profile sign <file> --admin <key> | profile link <file>  [--identity <dir>] [--profile <profile>] [--relay <url>]... [--addr <ip:port>]... [--bind <ip:port>]";

#[derive(Default)]
struct Args {
    command: String,
    target: Option<String>,
    identity: Option<PathBuf>,
    relays: Vec<RelayUrl>,
    addrs: Vec<SocketAddr>,
    bind: Option<SocketAddr>,
    relay_role: bool,
    socket: Option<PathBuf>,
    profile: Option<String>,
    admin: Option<PathBuf>,
    /// What follows `profile`'s verb.
    rest: Vec<String>,
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
            "--socket" => args.socket = Some(value(&mut argv, &arg)?.into()),
            "--profile" => args.profile = Some(value(&mut argv, &arg)?),
            "--admin" => args.admin = Some(value(&mut argv, &arg)?.into()),
            flag if flag.starts_with("--") => bail!("unknown option {flag}\n{USAGE}"),
            _ if args.command.is_empty() => args.command = arg,
            _ if args.target.is_none() => args.target = Some(arg),
            _ if args.command == "profile" => args.rest.push(arg),
            _ => bail!("unexpected {arg}\n{USAGE}"),
        }
    }
    Ok(args)
}

impl Args {
    /// The network profile's reach; relays named on the command line are reached alone.
    fn reach(&self) -> Result<Reach> {
        if !self.relays.is_empty() {
            return Ok(Reach {
                relays: self.relays.clone(),
                mdns: false,
            });
        }
        match &self.profile {
            Some(given) => profile::load(&read_profile(given)?)?.profile.reach(),
            None => Ok(Reach::local()),
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
            let reach = args.reach()?;
            let endpoint =
                net::endpoint(args.device_key()?, &reach, vec![ping::ALPN.to_vec()]).await?;
            let router = Router::builder(endpoint).accept(ping::ALPN, Pong).spawn();
            let endpoint = router.endpoint();
            if !reach.relays.is_empty() {
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
            let reach = args.reach()?;
            let mut to = EndpointAddr::new(id);
            for addr in &args.addrs {
                to = to.with_ip_addr(*addr);
            }
            // Without a lookup server, the device is looked for at the network's relays.
            for url in &reach.relays {
                to = to.with_relay_url(url.clone());
            }
            let endpoint = net::endpoint(args.device_key()?, &reach, vec![]).await?;
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
        "daemon" => {
            let socket = args.socket.clone().context(USAGE)?;
            hive_net::daemon::run(&socket, args.device_key()?, args.reach()?).await?;
        }
        "profile" => profile_command(&args)?,
        "doctor" => {
            let reach = args.reach()?;
            let key = args.device_key()?;
            println!("{}", hive_net::doctor::check(key, &reach).await);
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

/// A profile given on the command line: a built-in's name, a link, or a file holding either.
fn read_profile(given: &str) -> Result<String> {
    if profile::builtin(given).is_some() || given.starts_with(profile::LINK_PREFIX) {
        return Ok(given.to_string());
    }
    std::fs::read_to_string(given).with_context(|| format!("cannot read {given}"))
}

fn profile_command(args: &Args) -> Result<()> {
    let what = args.rest.first().context(USAGE)?;
    match args.target.as_deref() {
        Some("verify") => println!("{}", profile::load(&read_profile(what)?)?.describe()),
        Some("sign") => {
            let admin = args
                .admin
                .as_deref()
                .context("sign with --admin <file holding the admin key's seed>")?;
            let text =
                std::fs::read_to_string(what).with_context(|| format!("cannot read {what}"))?;
            let signed = profile::sign(text.trim_end(), &key::seed_file(admin, "key")?)?;
            println!("{}", serde_json::to_string_pretty(&signed)?);
        }
        Some("link") => {
            let text =
                std::fs::read_to_string(what).with_context(|| format!("cannot read {what}"))?;
            let file: profile::Signed =
                serde_json::from_str(&text).context("not a signed profile")?;
            profile::verify(&file)?;
            println!("{}", profile::link(&file));
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
