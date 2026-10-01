//! The lookup role (§12.2): where a device says how it is reached (its relay), signed by its key,
//! so other devices find it by its id alone; and where a workspace's host record is kept (§5.8,
//! `host_record.rs`). It embeds iroh's `iroh-dns-server`: pkarr over HTTP (`PUT` and `GET
//! /pkarr/<key>`), which `serve.rs` serves; it accepts any packet signed by the key it is filed
//! under, up to 1000 bytes, keeps the newest, and forgets one not published again for a week.
//! Nothing is asked of the BitTorrent DHT, and its DNS side answers only where it is asked to.
//! How often one address may publish is held back here, by the address the front saw
//! (`PutLimit`): `iroh-dns-server` 1.3's own limit counts the address that reached it, which is
//! the front's, so behind any front every device would share one.

use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use iroh_dns_server::{config::Config, Server};
use serde_json::json;

/// How many records one address may publish at once…
const BURST: f64 = 5.0;
/// …and how soon after that it may publish one more.
const EVERY: Duration = Duration::from_secs(2);
/// Past this many addresses, those that have not published lately are forgotten.
const ADDRESSES: usize = 100_000;

/// What holds back publishing: each address may publish [`BURST`] records at once, then one every
/// [`EVERY`].
#[derive(Debug, Default)]
pub struct PutLimit {
    buckets: Mutex<HashMap<IpAddr, (f64, Instant)>>,
}

impl PutLimit {
    /// Whether `from` may publish now; when it may, this one is counted.
    pub fn allow(&self, from: IpAddr) -> bool {
        let now = Instant::now();
        let refill = |tokens: f64, at: Instant| {
            (tokens + now.duration_since(at).as_secs_f64() / EVERY.as_secs_f64()).min(BURST)
        };
        let mut buckets = self.buckets.lock().unwrap();
        if buckets.len() > ADDRESSES {
            buckets.retain(|_, (tokens, at)| refill(*tokens, *at) < BURST);
        }
        let (tokens, at) = buckets.entry(from).or_insert((BURST, now));
        *tokens = refill(*tokens, *at);
        *at = now;
        if *tokens >= 1.0 {
            *tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// A running lookup server; it stops when dropped.
pub struct Lookup {
    server: Server,
    http: SocketAddr,
    limit: Option<Arc<PutLimit>>,
}

impl Lookup {
    /// A lookup server keeping its records in `dir`, answering DNS on `dns` if given, holding
    /// back publishing from one address unless `limited` is false (a network whose devices share
    /// one address: an office behind one NAT).
    pub async fn spawn(dir: &Path, dns: Option<SocketAddr>, limited: bool) -> Result<Self> {
        std::fs::create_dir_all(dir).with_context(|| format!("cannot make {}", dir.display()))?;
        let dns = dns.unwrap_or(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0));
        // Its HTTP side listens on this machine only: what reaches it comes through the front.
        let config: Config = serde_json::from_value(json!({
            "http": { "port": 0, "bind_addr": "127.0.0.1" },
            "https": null,
            "dns": {
                "port": dns.port(),
                "bind_addr": dns.ip(),
                "default_soa": "hive-net hostmaster.hive-net 0 10800 3600 604800 3600",
                "default_ttl": 30,
                "origins": ["."],
                "rr_a": null,
                "rr_aaaa": null,
                "rr_ns": null,
            },
            "metrics": { "disabled": true, "bind_addr": null },
            "mainline": { "enabled": false, "bootstrap": null },
            "zone_store": null,
            "pkarr_put_rate_limit": "disabled",
            "data_dir": dir,
        }))
        .context("the lookup server's settings")?;
        let server = Server::bind(config)
            .await
            .map_err(|e| anyhow::anyhow!("the lookup server: {e}"))?;
        let http = server
            .http_addr()
            .context("the lookup server serves HTTP")?;
        Ok(Self {
            server,
            http,
            limit: limited.then(Arc::default),
        })
    }

    /// Where the front passes requests on to it.
    pub fn http_addr(&self) -> SocketAddr {
        self.http
    }

    /// What holds back publishing, when anything does.
    pub fn limit(&self) -> Option<Arc<PutLimit>> {
        self.limit.clone()
    }

    /// Where it answers DNS.
    pub fn dns_addr(&self) -> SocketAddr {
        self.server.dns_addr()
    }

    /// Serve until it stops.
    pub async fn run(self) -> Result<()> {
        self.server
            .join()
            .await
            .map_err(|e| anyhow::anyhow!("the lookup server stopped: {e}"))
    }
}
