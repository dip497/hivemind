//! `hive-net`: this machine's device on the network (R10, R16).
//!
//!   hive-net id                    print this device's id (its EndpointId)
//!   hive-net run                   answer pings until stopped
//!   hive-net ping <id>             ping a device by its id
//!   hive-net serve [--relay] [--lookup] [--access] [--all] [--domain <name>] [--data <dir>] …
//!                                  the server roles on one port (`serve.rs`): a relay (for the
//!                                  devices the access role allows), a lookup server, the access
//!                                  role; `--all` is all three
//!   hive-net access voucher --kind enrol|visit [--device <id>] [--expires-in <s>] [--uses <n>]
//!                                  a voucher signed by this device (or `--admin <key file>`)
//!   hive-net access redeem|vouch <url> <voucher>   use one at a network's access service
//!   hive-net access register <url>  register this device on an `open-pow` network
//!   hive-net access revoke <url> <id>  take a device's admission back
//!   hive-net access enrol-link <signed profile> --admin <key> [--expires-in <s>] [--uses <n>]
//!                                  a link that puts a device on the network and enrols it
//!   hive-net host-record publish --workspace <id> --seq <n> [--host <id>]
//!                                  say which device hosts one of this person's workspaces
//!   hive-net host-record resolve <workspace key> | --workspace <id>
//!                                  which device hosts a workspace, as JSON (null: none known)
//!   hive-net daemon --socket <path>  the app's network (`daemon.rs`); main starts it
//!   hive-net doctor                whether the network's servers answer, as JSON
//!   hive-net profile verify <profile> [--replacing <profile>]  the profile, if it is one this
//!                                  may use (and may replace the one named), as JSON
//!   hive-net profile sign <file> --admin <key>  sign a profile's text as its network's admin
//!   hive-net profile link <file>   the link that carries a signed profile
//!
//! Options: `--identity <dir>` (default: the app's), `--profile <profile>` (the network: `local`,
//! the default, `hosted`, a signed profile's file or its link), `--relay <url>` (repeatable:
//! reach devices through these relays only), `--lookup <url>` (with `--relay`: and find devices
//! through this lookup server), `--addr <ip:port>` (ping: where the device is, when mDNS cannot
//! find it).
//!
//! Serving: `--bind <ip:port>` (default [::]:3340, or [::]:443 with HTTPS); HTTPS with
//! `--domain <name>` (a certificate from Let's Encrypt; `--contact <email>`), or `--cert <pem>
//! --key <pem>` (files, read again every hour; `--domain` then only names the server); with
//! HTTPS, `--quic-bind` (QUIC address discovery, default [::]:7842) and `--http-bind` (the
//! captive-portal check, default [::]:80). `--data <dir>` keeps the roles' state. The access
//! role: `--admin-id <key>` (default: the admin key kept in `--data`, made there the first time),
//! `--policy closed|open-pow` (default closed), `--pow-bits <n>` (default 20). A relay without
//! the access role beside it asks one elsewhere: `--access-url <url>`, keeping a yes for
//! `--access-cache <s>` (default 300; a no for at most 10). The lookup server:
//! `--dns-bind <ip:port>` (answer DNS there too), `--lookup-limit per-address|off`. `--url
//! <base>` is how devices reach this server, when it is not what `--domain` or `--bind` says;
//! with it (or `--domain`), and the admin key kept here, the network's link is printed, its
//! signed profile kept as `network.json` in `--data`; `--name` names the network.

use std::{
    net::SocketAddr, path::PathBuf, process::ExitCode, str::FromStr, sync::Arc, time::Duration,
};

use anyhow::{bail, Context, Result};
use hive_net::{
    access::{self, Service},
    host_record::{self, HostRecord},
    key,
    net::{self, Reach},
    ping::{self, Pong},
    profile,
    serve::{Certificate, Options, Serving},
};
use iroh::{protocol::Router, EndpointAddr, EndpointId, PublicKey, RelayUrl, TransportAddr};
use iroh_relay::server::{AllowAll, DynAccessControl};

/// How long a ping waits for its answer.
const PING_TIMEOUT: Duration = Duration::from_secs(10);

const USAGE: &str = "usage: hive-net id | run | ping <id> | serve [--relay] [--lookup] [--access] [--all] … | daemon --socket <path> | doctor | profile verify|sign|link … | access voucher|redeem|vouch|register|revoke|enrol-link … | host-record publish|resolve …  [--identity <dir>] [--profile <profile>] [--relay <url>]... [--lookup <url>] [--addr <ip:port>]... [--bind <ip:port>]";

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
    lookup_role: bool,
    all: bool,
    lookup: Option<url::Url>,
    admin_id: Option<String>,
    policy: Option<String>,
    data: Option<PathBuf>,
    pow_bits: Option<u32>,
    domain: Option<String>,
    contact: Option<String>,
    cert: Option<PathBuf>,
    key: Option<PathBuf>,
    http_bind: Option<SocketAddr>,
    quic_bind: Option<SocketAddr>,
    dns_bind: Option<SocketAddr>,
    access_url: Option<String>,
    access_cache: Option<u64>,
    url: Option<String>,
    name: Option<String>,
    lookup_limit: Option<String>,
    workspace: Option<String>,
    host: Option<String>,
    seq: Option<u64>,
    kind: Option<String>,
    device: Option<String>,
    expires_in: Option<u64>,
    uses: Option<u32>,
    replacing: Option<String>,
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
            "--lookup" if args.command == "serve" => args.lookup_role = true,
            "--lookup" => args.lookup = Some(value(&mut argv, &arg)?.parse()?),
            "--all" => args.all = true,
            "--admin-id" => args.admin_id = Some(value(&mut argv, &arg)?),
            "--policy" => args.policy = Some(value(&mut argv, &arg)?),
            "--data" => args.data = Some(value(&mut argv, &arg)?.into()),
            "--pow-bits" => args.pow_bits = Some(value(&mut argv, &arg)?.parse()?),
            "--domain" => args.domain = Some(value(&mut argv, &arg)?),
            "--contact" => args.contact = Some(value(&mut argv, &arg)?),
            "--cert" => args.cert = Some(value(&mut argv, &arg)?.into()),
            "--key" => args.key = Some(value(&mut argv, &arg)?.into()),
            "--http-bind" => args.http_bind = Some(value(&mut argv, &arg)?.parse()?),
            "--quic-bind" => args.quic_bind = Some(value(&mut argv, &arg)?.parse()?),
            "--dns-bind" => args.dns_bind = Some(value(&mut argv, &arg)?.parse()?),
            "--access-url" => args.access_url = Some(value(&mut argv, &arg)?),
            "--access-cache" => args.access_cache = Some(value(&mut argv, &arg)?.parse()?),
            "--url" => args.url = Some(value(&mut argv, &arg)?),
            "--name" => args.name = Some(value(&mut argv, &arg)?),
            "--lookup-limit" => args.lookup_limit = Some(value(&mut argv, &arg)?),
            "--workspace" => args.workspace = Some(value(&mut argv, &arg)?),
            "--host" => args.host = Some(value(&mut argv, &arg)?),
            "--seq" => args.seq = Some(value(&mut argv, &arg)?.parse()?),
            "--kind" => args.kind = Some(value(&mut argv, &arg)?),
            "--device" => args.device = Some(value(&mut argv, &arg)?),
            "--expires-in" => args.expires_in = Some(value(&mut argv, &arg)?.parse()?),
            "--uses" => args.uses = Some(value(&mut argv, &arg)?.parse()?),
            "--replacing" => args.replacing = Some(value(&mut argv, &arg)?),
            flag if flag.starts_with("--") => bail!("unknown option {flag}\n{USAGE}"),
            _ if args.command.is_empty() => args.command = arg,
            _ if args.target.is_none() => args.target = Some(arg),
            _ if matches!(args.command.as_str(), "profile" | "access" | "host-record") => {
                args.rest.push(arg)
            }
            _ => bail!("unexpected {arg}\n{USAGE}"),
        }
    }
    Ok(args)
}

impl Args {
    /// The network profile's reach; relays named on the command line are reached alone, with
    /// the lookup server named beside them.
    fn reach(&self) -> Result<Reach> {
        if !self.relays.is_empty() {
            return Ok(Reach {
                relays: self.relays.clone(),
                lookup: self.lookup.clone(),
                mdns: false,
            });
        }
        Ok(self.network()?.reach()?)
    }

    /// The network profile in use: the one given, or the local network.
    fn network(&self) -> Result<profile::Profile> {
        Ok(match &self.profile {
            Some(given) => profile::load(&read_profile(given)?)?.profile,
            None => profile::builtin("local").expect("built in").profile,
        })
    }

    fn identity_dir(&self) -> Result<PathBuf> {
        match &self.identity {
            Some(dir) => Ok(dir.clone()),
            None => key::app_identity_dir()
                .context("cannot tell where the app keeps its keys: give --identity"),
        }
    }

    fn device_key(&self) -> Result<iroh::SecretKey> {
        key::device_key(&self.identity_dir()?)
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
            if reach.lookup.is_none() {
                for url in &reach.relays {
                    to = to.with_relay_url(url.clone());
                }
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
            let access = args.network()?.access.map(|a| a.url);
            let key = args.device_key()?;
            println!("{}", hive_net::doctor::check(key, &reach, access).await);
        }
        "serve" if args.relay_role || args.lookup_role || args.access_role || args.all => {
            serve(&args).await?
        }
        "access" => access_command(&args).await?,
        "host-record" => host_record_command(&args).await?,
        _ => bail!("{USAGE}"),
    }
    Ok(())
}

/// The server roles asked for, on one port (`serve.rs`): a relay, a lookup server and the access
/// role, in any mix (`--all`: every one). A relay admits what the access role beside it allows,
/// or asks one elsewhere (`--access-url`), or admits every device.
async fn serve(args: &Args) -> Result<()> {
    let relay_role = args.relay_role || args.all;
    let lookup_role = args.lookup_role || args.all;
    let access_role = args.access_role || args.all;
    let data = || {
        args.data
            .clone()
            .context("give --data <dir>: where the server keeps what it must not forget")
    };

    // The network's admin: the key named, or the one kept with the server's state.
    let mut admin_key = None;
    let access = if access_role {
        let admin = match &args.admin_id {
            Some(id) => PublicKey::from_str(id).with_context(|| format!("{id} is not a key"))?,
            None => {
                let (key, made) = key::admin_key(&data()?)?;
                if made {
                    println!(
                        "made the network's admin key, {}: back it up; whoever holds it runs the network",
                        data()?.join(key::ADMIN_KEY).display()
                    );
                }
                let public = key.public();
                admin_key = Some(key);
                public
            }
        };
        let policy = match args.policy.as_deref().unwrap_or("closed") {
            "closed" => profile::Policy::Closed,
            "open-pow" => profile::Policy::OpenPow,
            other => bail!("{other} is not a policy: closed or open-pow"),
        };
        Some(Service::open(
            &data()?,
            admin,
            policy,
            args.pow_bits.unwrap_or(20),
        )?)
    } else {
        None
    };
    let certificate = match (&args.cert, &args.key) {
        (Some(cert), Some(key)) => Some(Certificate::Files {
            cert: cert.clone(),
            key: key.clone(),
        }),
        (None, None) => match &args.domain {
            Some(domain) => Some(Certificate::LetsEncrypt {
                domains: vec![domain.clone()],
                contact: args.contact.clone(),
                cache: data()?.join("acme"),
            }),
            None => None,
        },
        _ => bail!("--cert and --key go together"),
    };
    let https = certificate.is_some();
    let relay: Option<Arc<dyn DynAccessControl>> = if relay_role {
        Some(match (&access, &args.access_url) {
            (Some(service), _) => Arc::new(service.clone()),
            (None, Some(url)) => Arc::new(access::Remote::new(
                url,
                args.access_cache
                    .map(Duration::from_secs)
                    .unwrap_or(access::REMEMBER),
            )?),
            (None, None) => Arc::new(AllowAll),
        })
    } else {
        None
    };
    let limited = match args.lookup_limit.as_deref().unwrap_or("per-address") {
        "per-address" => true,
        "off" => false,
        other => bail!("{other} is not a lookup limit: per-address or off"),
    };
    let lookup = if lookup_role {
        Some((data()?.join("lookup"), args.dns_bind, limited))
    } else {
        None
    };
    let default_bind = if https { "[::]:443" } else { "[::]:3340" };
    let serving = Serving::spawn(Options {
        bind: args.bind.unwrap_or_else(|| default_bind.parse().unwrap()),
        certificate,
        relay,
        quic_bind: args
            .quic_bind
            .unwrap_or_else(|| "[::]:7842".parse().unwrap()),
        http_bind: args.http_bind.unwrap_or_else(|| "[::]:80".parse().unwrap()),
        lookup,
        access: access.clone(),
    })
    .await?;

    let base = base_url(args, &serving);
    if relay_role {
        println!("relay serving on {base}");
    }
    if lookup_role {
        println!("lookup serving on {base}/pkarr");
        if let (Some(_), Some(dns)) = (args.dns_bind, serving.dns_addr()) {
            println!("lookup answering DNS on {dns}");
        }
    }
    if access_role {
        println!("access serving on {base}/access");
    }
    if let Some(admin) = &admin_key {
        if args.url.is_some() || args.domain.is_some() {
            let signed = network_profile(args, &data()?, &base, admin, relay_role, lookup_role)?;
            println!("network link: {}", profile::link(&signed));
        } else {
            println!(
                "give --url <how devices reach this server> (or --domain) for the network's link"
            );
        }
    }
    serving.run().await
}

/// How devices reach the server: `--url`, or what `--domain` or the address it listens on says.
fn base_url(args: &Args, serving: &Serving) -> String {
    if let Some(url) = &args.url {
        return url.trim_end_matches('/').to_string();
    }
    let scheme = if serving.https() { "https" } else { "http" };
    let addr = serving.addr();
    match &args.domain {
        Some(domain) if addr.port() == 443 => format!("{scheme}://{domain}"),
        Some(domain) => format!("{scheme}://{domain}:{}", addr.port()),
        None => format!("{scheme}://{addr}"),
    }
}

/// The network's profile, signed by its admin and kept as `network.json` in `data`: made again
/// only when what it says changes, so its link stays the same from one start to the next.
fn network_profile(
    args: &Args,
    data: &std::path::Path,
    base: &str,
    admin: &iroh::SecretKey,
    relay: bool,
    lookup: bool,
) -> Result<profile::Signed> {
    let policy = match args.policy.as_deref().unwrap_or("closed") {
        "open-pow" => profile::Policy::OpenPow,
        _ => profile::Policy::Closed,
    };
    let host = url::Url::parse(base)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string));
    let mut want = profile::Profile {
        v: 1,
        name: args
            .name
            .clone()
            .or(args.domain.clone())
            .or(host)
            .unwrap_or_else(|| "hive-net".into()),
        relays: if relay {
            vec![profile::Relay { url: base.into() }]
        } else {
            vec![]
        },
        lookup: lookup.then(|| format!("{base}/pkarr")),
        access: Some(profile::AccessService {
            url: format!("{base}/access"),
            policy,
        }),
        push: None,
        admin: Some(admin.public().to_string()),
        local: profile::Local { mdns: true },
        issued_at: 0,
    };
    let file = data.join("network.json");
    if let Ok(kept) = std::fs::read_to_string(&file) {
        if let Ok(signed) = serde_json::from_str::<profile::Signed>(&kept) {
            if let Ok(verified) = profile::verify(&signed) {
                let mut was = verified.profile;
                was.issued_at = 0;
                if was == want {
                    return Ok(signed);
                }
            }
        }
    }
    want.issued_at = access::now_ms();
    let signed = profile::sign(&serde_json::to_string(&want)?, admin)?;
    std::fs::write(&file, serde_json::to_string_pretty(&signed)?)
        .with_context(|| format!("cannot write {}", file.display()))?;
    Ok(signed)
}

async fn host_record_command(args: &Args) -> Result<()> {
    let lookup = match &args.lookup {
        Some(url) => url.clone(),
        None => args
            .network()?
            .reach()?
            .lookup
            .context("the network has no lookup server: give --lookup <url>")?,
    };
    match args.target.as_deref() {
        Some("publish") => {
            let workspace = args.workspace.as_deref().context("--workspace <id>")?;
            let seq = args.seq.context("--seq <n>")?;
            let identity = args.identity_dir()?;
            let key = key::workspace_key(&key::person_key(&identity)?, workspace)?;
            let host = match &args.host {
                Some(id) => {
                    EndpointId::from_str(id).with_context(|| format!("{id} is not a device id"))?
                }
                None => key::device_key(&identity)?.public(),
            };
            host_record::publish(&lookup, &key, HostRecord { host, seq }).await?;
            println!(
                "{}",
                serde_json::json!({ "workspace": key.public().to_string(), "host": host.to_string(), "seq": seq })
            );
        }
        Some("resolve") => {
            let workspace = match (args.rest.first(), &args.workspace) {
                (Some(given), _) => PublicKey::from_str(given)
                    .with_context(|| format!("{given} is not a workspace's key"))?,
                (None, Some(id)) => {
                    key::workspace_key(&key::person_key(&args.identity_dir()?)?, id)?.public()
                }
                _ => bail!("{USAGE}"),
            };
            let found = host_record::resolve(&lookup, workspace).await?;
            println!(
                "{}",
                match found {
                    Some(r) => serde_json::json!({ "host": r.host.to_string(), "seq": r.seq }),
                    None => serde_json::Value::Null,
                }
            );
        }
        _ => bail!("{USAGE}"),
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
        "enrol-link" => {
            let file = profile::signed(&read_profile(arg(0)?)?)?;
            let network = profile::verify(&file)?;
            let admin = key::seed_file(
                args.admin
                    .as_deref()
                    .context("--admin <file holding the network's admin key>")?,
                "key",
            )?;
            if network.admin != Some(admin.public()) {
                bail!("that key is not the network's admin");
            }
            let expires = now_ms() + args.expires_in.unwrap_or(7 * 24 * 3600) * 1000;
            let v = Voucher::new(Kind::Enrol, &admin, None, expires, args.uses.unwrap_or(1));
            println!(
                "{}",
                profile::enrolment_link(&file, serde_json::to_value(&v)?)
            );
        }
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
        Some("verify") => {
            let next = profile::load(&read_profile(what)?)?;
            // Replacing the network in use: an update to it must come from its admin.
            if let Some(current) = &args.replacing {
                profile::same_admin(&profile::load(&read_profile(current)?)?, &next)?;
            }
            println!("{}", next.describe());
        }
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
