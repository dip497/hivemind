//! `hive-net`: this machine's device on the network (R10, R16).
//!
//!   hive-net id                    print this device's id (its EndpointId)
//!   hive-net run                   answer pings until stopped
//!   hive-net ping <id>             ping a device by its id
//!   hive-net serve --relay [--access --admin-id <key> --policy closed|open-pow --data <dir>]
//!                                  a relay, for the devices the network's access role allows
//!   hive-net access voucher --kind enrol|visit [--device <id>] [--expires-in <s>] [--uses <n>]
//!                                  a voucher signed by this device (or `--admin <key file>`)
//!   hive-net access redeem|vouch <url> <voucher>   use one at a network's access service
//!   hive-net access register <url>  register this device on an `open-pow` network
//!   hive-net access revoke <url> <id>  take a device's admission back
//!   hive-net daemon --socket <path>  the app's network (`daemon.rs`); main starts it
//!   hive-net doctor                whether the network's servers answer, as JSON
//!   hive-net profile verify <profile>        the profile, if it is one this may use, as JSON
//!   hive-net profile sign <file> --admin <key>  sign a profile's text as its network's admin
//!   hive-net profile link <file>   the link that carries a signed profile
//!
//! Options: `--identity <dir>` (default: the app's), `--profile <profile>` (the network: `local`,
//! the default, `hosted`, a signed profile's file or its link), `--relay <url>` (repeatable:
//! reach devices through these relays only), `--addr <ip:port>` (ping: where the device is, when
//! mDNS cannot find it), `--bind <ip:port>` (serve; default [::]:3340), `--access-bind <ip:port>`
//! (serve; default [::]:3341), `--pow-bits <n>` (serve, `open-pow`: the work asked; default 20).

use std::{net::SocketAddr, path::PathBuf, process::ExitCode, str::FromStr, time::Duration};

use anyhow::{bail, Context, Result};
use hive_net::{
    access::Service,
    key,
    net::{self, Reach},
    ping::{self, Pong},
    profile,
    serve::Relay,
};
use iroh::{protocol::Router, EndpointAddr, EndpointId, RelayUrl, TransportAddr};

/// How long a ping waits for its answer.
const PING_TIMEOUT: Duration = Duration::from_secs(10);

const USAGE: &str = "usage: hive-net id | run | ping <id> | serve --relay [--access …] | daemon --socket <path> | doctor | profile verify|sign|link … | access voucher|redeem|vouch|register|revoke …  [--identity <dir>] [--profile <profile>] [--relay <url>]... [--addr <ip:port>]... [--bind <ip:port>]";

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
    /// What follows `profile`'s or `access`'s verb.
    rest: Vec<String>,
    access_role: bool,
    admin_id: Option<String>,
    policy: Option<String>,
    data: Option<PathBuf>,
    access_bind: Option<SocketAddr>,
    pow_bits: Option<u32>,
    kind: Option<String>,
    device: Option<String>,
    expires_in: Option<u64>,
    uses: Option<u32>,
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
            "--access" => args.access_role = true,
            "--admin-id" => args.admin_id = Some(value(&mut argv, &arg)?),
            "--policy" => args.policy = Some(value(&mut argv, &arg)?),
            "--data" => args.data = Some(value(&mut argv, &arg)?.into()),
            "--access-bind" => args.access_bind = Some(value(&mut argv, &arg)?.parse()?),
            "--pow-bits" => args.pow_bits = Some(value(&mut argv, &arg)?.parse()?),
            "--kind" => args.kind = Some(value(&mut argv, &arg)?),
            "--device" => args.device = Some(value(&mut argv, &arg)?),
            "--expires-in" => args.expires_in = Some(value(&mut argv, &arg)?.parse()?),
            "--uses" => args.uses = Some(value(&mut argv, &arg)?.parse()?),
            flag if flag.starts_with("--") => bail!("unknown option {flag}\n{USAGE}"),
            _ if args.command.is_empty() => args.command = arg,
            _ if args.target.is_none() => args.target = Some(arg),
            _ if args.command == "profile" || args.command == "access" => args.rest.push(arg),
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
        "serve" if args.relay_role || args.access_role => serve(&args).await?,
        "access" => access_command(&args).await?,
        _ => bail!("{USAGE}"),
    }
    Ok(())
}

/// The server roles asked for: a relay, the access role, or both, the relay then admitting what
/// the access role allows.
async fn serve(args: &Args) -> Result<()> {
    let access = if args.access_role {
        let admin = args
            .admin_id
            .as_deref()
            .context("the access role needs the network's --admin-id")?;
        let admin =
            iroh::PublicKey::from_str(admin).with_context(|| format!("{admin} is not a key"))?;
        let policy = match args.policy.as_deref().unwrap_or("closed") {
            "closed" => profile::Policy::Closed,
            "open-pow" => profile::Policy::OpenPow,
            other => bail!("{other} is not a policy: closed or open-pow"),
        };
        let data = args
            .data
            .clone()
            .context("the access role keeps what it allows in --data <dir>")?;
        let service = Service::open(&data, admin, policy, args.pow_bits.unwrap_or(20))?;
        let at = service
            .clone()
            .serve(
                args.access_bind
                    .unwrap_or_else(|| "[::]:3341".parse().unwrap()),
            )
            .await?;
        Some((service, at))
    } else {
        None
    };
    let relay = if args.relay_role {
        let relay = Relay::spawn(
            args.bind.unwrap_or_else(|| "[::]:3340".parse().unwrap()),
            access.as_ref().map(|(s, _)| s.clone()),
        )
        .await?;
        println!("relay serving on {}", relay.url());
        Some(relay)
    } else {
        None
    };
    if let Some((_, at)) = &access {
        println!("access serving on http://{at}");
    }
    match relay {
        Some(relay) => relay.run().await?,
        None => tokio::signal::ctrl_c().await?,
    }
    Ok(())
}

async fn access_command(args: &Args) -> Result<()> {
    use hive_net::access::{client, now_ms, Kind, Voucher};
    let verb = args.target.as_deref().context(USAGE)?;
    let arg = |i: usize| args.rest.get(i).map(String::as_str).context(USAGE);
    // A voucher given as its JSON, or a file holding it.
    let voucher = |given: &str| -> Result<Voucher> {
        let text = if given.trim_start().starts_with('{') {
            given.to_string()
        } else {
            std::fs::read_to_string(given).with_context(|| format!("cannot read {given}"))?
        };
        serde_json::from_str(&text).context("not a voucher")
    };
    match verb {
        "voucher" => {
            let kind = match args.kind.as_deref() {
                Some("enrol") => Kind::Enrol,
                Some("visit") => Kind::Visit,
                _ => bail!("--kind enrol or --kind visit"),
            };
            let by = match &args.admin {
                Some(file) => key::seed_file(file, "key")?,
                None => args.device_key()?,
            };
            let device = args
                .device
                .as_deref()
                .map(|d| {
                    iroh::PublicKey::from_str(d).with_context(|| format!("{d} is not a device id"))
                })
                .transpose()?;
            let expires = now_ms() + args.expires_in.unwrap_or(24 * 3600) * 1000;
            let v = Voucher::new(kind, &by, device, expires, args.uses.unwrap_or(1));
            println!("{}", serde_json::to_string(&v)?);
        }
        "redeem" => client::redeem(arg(0)?, &voucher(arg(1)?)?, &args.device_key()?).await?,
        "vouch" => client::vouch(arg(0)?, &voucher(arg(1)?)?).await?,
        "register" => client::register(arg(0)?, &args.device_key()?).await?,
        "revoke" => {
            let by = match &args.admin {
                Some(file) => key::seed_file(file, "key")?,
                None => args.device_key()?,
            };
            let device = iroh::PublicKey::from_str(arg(1)?).context("not a device id")?;
            client::revoke(arg(0)?, &device, &by).await?;
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
