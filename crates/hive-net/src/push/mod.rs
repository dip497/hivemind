//! The push role (design §12.4, spec/push.md 0.3): how a phone that cannot be reached at an
//! address of its own is told what happens on the person's devices. A phone registers (`store`),
//! proving its device key and naming the devices that may tell it, and is given a handle; those
//! devices post their notices, encrypted to the phone (Web Push) and signed with their device key
//! (`wire`), to the handle's address; and the role passes each on, unread, to where the phone said:
//! a UnifiedPush distributor (`unifiedpush`), Apple's push service (`apns`) or Google's (`fcm`).
//! It keeps the phones' registrations and nothing of what it passes on. `serve.rs` serves it under
//! `/push`.

mod apns;
pub mod client;
mod fcm;
mod store;
mod unifiedpush;
mod wire;

use std::{
    collections::HashMap,
    net::IpAddr,
    path::Path,
    str::FromStr,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{ensure, Context, Result};
pub use apns::Apns;
use bytes::Bytes;
pub use fcm::Fcm;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{body::Incoming, HeaderMap, Request, Response};
use iroh::PublicKey;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
pub use wire::Platform;

use crate::{
    access,
    egress::{self, Allowed},
    limit::{self, Limit},
    signed::{self, now_ms},
};
use store::{Registration, Store};
use unifiedpush::Vapid;
use wire::{Registering, Urgency};

/// How many notices one phone is passed at once, then one a second: sixty a minute.
const PHONE_BURST: u32 = 60;
const PHONE_EVERY: Duration = Duration::from_secs(1);
/// How many requests one address may make at once, then ten a second: six hundred a minute.
const ADDRESS_BURST: u32 = 600;
const ADDRESS_EVERY: Duration = Duration::from_millis(100);
/// Past this many phones or addresses, those whose buckets are full again are forgotten.
const SOURCES: usize = 100_000;
/// How long a notice's service has, all told: less than the device posting it waits.
const UPSTREAM_PATIENCE: Duration = Duration::from_secs(10);
/// How long a request has to come whole.
const BODY_PATIENCE: Duration = Duration::from_secs(30);
/// The largest registration read.
const MAX_REGISTRATION: usize = 16 * 1024;
/// The most of a service's answer read.
const MAX_ANSWER: usize = 8 * 1024;

/// A request to send upstream.
#[derive(Debug)]
pub(crate) struct Outgoing {
    url: String,
    headers: Vec<(&'static str, String)>,
    body: Vec<u8>,
}

/// What became of a notice passed on.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Passed {
    Delivered,
    /// The phone's service no longer knows it: its registration is dropped.
    Gone,
    /// Too large for the phone's service.
    TooLarge,
    /// Not taken, for this reason, which names no phone.
    Failed(String),
}

/// What the role is given.
#[derive(Default)]
pub struct Options {
    /// Apple's push service, with this server's credentials for it.
    pub apns: Option<Apns>,
    /// Google's, likewise.
    pub fcm: Option<Fcm>,
    /// The network's access role, beside this one: a phone registers while it allows it.
    pub admits: Option<access::Service>,
    /// The networks of this server's own a phone may be told at.
    pub allowed: Allowed,
    /// Who runs the server, as its VAPID tokens say: a `mailto:` or `https:` URL.
    pub contact: Option<String>,
}

/// The push role: one per network.
#[derive(Clone)]
pub struct Service {
    inner: Arc<Inner>,
}

struct Inner {
    store: Store,
    vapid: Vapid,
    apns: Option<Apns>,
    fcm: Option<Fcm>,
    admits: Option<access::Service>,
    allowed: Allowed,
    /// For Apple's and Google's services, and for the phones' distributors.
    upstream: reqwest::Client,
    distributors: reqwest::Client,
    by_address: Limit<IpAddr>,
    by_phone: Limit<String>,
    /// Each notice passed on, until its time is too old for it to be taken again; and when those
    /// past that are next let go.
    seen: Mutex<(HashMap<String, u64>, u64)>,
}

impl Service {
    /// The role, keeping its registrations and its VAPID key in `dir`.
    pub fn open(dir: &Path, o: Options) -> Result<Self> {
        std::fs::create_dir_all(dir).with_context(|| format!("cannot make {}", dir.display()))?;
        Ok(Self {
            inner: Arc::new(Inner {
                store: Store::open(dir)?,
                vapid: Vapid::open(dir, o.contact)?,
                upstream: egress::upstream()?,
                distributors: egress::guarded(o.allowed.clone())?,
                apns: o.apns,
                fcm: o.fcm,
                admits: o.admits,
                allowed: o.allowed,
                by_address: Limit::new(ADDRESS_BURST, ADDRESS_EVERY, SOURCES),
                by_phone: Limit::new(PHONE_BURST, PHONE_EVERY, SOURCES),
                seen: Mutex::new((HashMap::new(), 0)),
            }),
        })
    }

    /// Where it tells phones: a UnifiedPush distributor's address always; Apple's and Google's
    /// services with their credentials (the network profile's `push.kinds`).
    pub fn kinds(&self) -> Vec<String> {
        let mut kinds = vec![];
        if self.inner.apns.is_some() {
            kinds.push("apns".to_string());
        }
        if self.inner.fcm.is_some() {
            kinds.push("fcm".to_string());
        }
        kinds.push("unifiedpush".to_string());
        kinds
    }

    /// Its VAPID key, for a phone to give its distributor (the network profile's `push.vapid`).
    pub fn vapid(&self) -> String {
        self.inner.vapid.public().to_string()
    }

    /// A phone registers: its handle, the one it was given when it registered here before.
    fn register(&self, r: Registering) -> Result<String> {
        ensure!(
            r.v == 1,
            "a registration of version {} is not one this reads",
            r.v
        );
        let device = PublicKey::from_str(&r.device).context("that device is no key")?;
        ensure!(
            signed::near(r.at, now_ms()),
            "the registration's time is too far from now"
        );
        ensure!(
            r.senders.len() <= wire::MAX_SENDERS,
            "a phone names at most {} devices",
            wire::MAX_SENDERS
        );
        let senders = r
            .senders
            .iter()
            .map(|s| PublicKey::from_str(s).map(|k| k.to_string()))
            .collect::<Result<Vec<_>, _>>()
            .context("a sender is no device")?;
        signed::verify(
            &device,
            &wire::register_bytes(&r.device, r.platform, &r.token, r.sandbox, &r.senders, r.at),
            &r.signature,
        )
        .context("the phone did not prove its key")?;
        if let Some(access) = &self.inner.admits {
            ensure!(access.allowed(&device), "this phone is not on the network");
        }
        ensure!(wire::token_ok(&r.token), "that is no token");
        match r.platform {
            Platform::Unifiedpush => egress::may_post(
                &url::Url::parse(&r.token).context("a UnifiedPush token is its address")?,
                &self.inner.allowed,
            )?,
            Platform::Apns => {
                ensure!(
                    self.inner.apns.is_some(),
                    "this server does not tell phones through APNs"
                );
                ensure!(
                    r.token.bytes().all(|b| b.is_ascii_hexdigit()),
                    "an APNs token is hex"
                );
            }
            Platform::Fcm => ensure!(
                self.inner.fcm.is_some(),
                "this server does not tell phones through FCM"
            ),
        }
        self.inner.store.register(Registration {
            device: device.to_string(),
            platform: r.platform,
            token: r.token,
            sandbox: r.sandbox,
            senders,
            at: r.at,
        })
    }

    /// Whether the notice `body` that `device` signed at `at` is one not passed on before.
    fn first(&self, device: &str, at: u64, body: &[u8]) -> bool {
        let now = now_ms();
        let mut seen = self.inner.seen.lock().unwrap();
        let (kept, purge) = &mut *seen;
        // Once a minute, the notices too old to be taken again are let go.
        if now >= *purge {
            kept.retain(|_, until| *until >= now);
            *purge = now + 60_000;
        }
        let key = format!("{device} {at} {}", hex::encode(Sha256::digest(body)));
        kept.insert(key, at + signed::CLOCK_SKEW_MS).is_none()
    }

    /// Pass the notice `body` on to `phone`, within [`UPSTREAM_PATIENCE`].
    async fn pass_on(
        &self,
        phone: &Registration,
        body: &[u8],
        ttl: u64,
        urgency: Urgency,
    ) -> Passed {
        let now = now_ms() / 1000;
        let sent = async {
            match phone.platform {
                Platform::Unifiedpush => {
                    let Ok(url) = url::Url::parse(&phone.token) else {
                        return Ok::<_, anyhow::Error>(Passed::Failed("told at no address".into()));
                    };
                    if egress::may_post(&url, &self.inner.allowed).is_err() {
                        return Ok(Passed::Failed("told at an address not allowed here".into()));
                    }
                    let out =
                        unifiedpush::request(&url, body, ttl, urgency, &self.inner.vapid, now)?;
                    let (status, _) = send(&self.inner.distributors, &out, false).await?;
                    Ok(unifiedpush::passed(status))
                }
                Platform::Apns => {
                    let apns = self
                        .inner
                        .apns
                        .as_ref()
                        .context("this server no longer tells phones through APNs")?;
                    let Some(payload) = apns::payload(body) else {
                        return Ok(Passed::TooLarge);
                    };
                    let out =
                        apns.request(&phone.token, phone.sandbox, payload, ttl, urgency, now)?;
                    let (status, answer) = send(&self.inner.upstream, &out, true).await?;
                    apns.forget_token(status, &answer);
                    Ok(apns::passed(status, &answer))
                }
                Platform::Fcm => {
                    let fcm = self
                        .inner
                        .fcm
                        .as_ref()
                        .context("this server no longer tells phones through FCM")?;
                    let Some(data) = fcm::data(body) else {
                        return Ok(Passed::TooLarge);
                    };
                    let bearer = fcm.bearer(&self.inner.upstream, now).await?;
                    let out = fcm.request(&phone.token, data, ttl, urgency, &bearer);
                    let (status, answer) = send(&self.inner.upstream, &out, true).await?;
                    fcm.forget_access(status).await;
                    Ok(fcm::passed(status, &answer))
                }
            }
        };
        let passed = match tokio::time::timeout(UPSTREAM_PATIENCE, sent).await {
            Ok(Ok(passed)) => passed,
            Ok(Err(e)) => Passed::Failed(format!("{e:#}")),
            Err(_) => Passed::Failed("no answer in time".into()),
        };
        // What went wrong, for whoever runs the server: never the phone's token, nor its handle.
        if passed != Passed::Delivered {
            eprintln!(
                "hive-net: push through {}: {passed:?}",
                phone.platform.name()
            );
        }
        passed
    }

    /// Answer one request from `peer`, its path relative to the role's URL.
    pub(crate) async fn handle(
        &self,
        req: Request<Incoming>,
        peer: IpAddr,
    ) -> Response<Full<Bytes>> {
        let (parts, body) = req.into_parts();
        let path = parts.uri.path().trim_start_matches('/').to_string();
        if parts.method == hyper::Method::POST && !self.inner.by_address.allow(limit::source(peer))
        {
            return answer(429, "too many requests: wait a little");
        }
        match (parts.method.as_str(), path.as_str()) {
            ("GET", "healthz") => json_answer(200, json!("ok")),
            ("POST", "register") => {
                let Some(bytes) = read(body, MAX_REGISTRATION).await else {
                    return answer(413, "the registration is too large, or did not come whole");
                };
                let registered = serde_json::from_slice::<Registering>(&bytes)
                    .context("not a registration")
                    .and_then(|r| self.register(r));
                match registered {
                    Ok(handle) => json_answer(200, json!({ "handle": handle })),
                    Err(e) => answer(403, &format!("{e:#}")),
                }
            }
            ("POST", handle)
                if handle.len() == 32 && handle.bytes().all(|b| b.is_ascii_hexdigit()) =>
            {
                self.notice(handle, &parts.headers, body).await
            }
            _ => answer(404, "not found"),
        }
    }

    /// A device posts a notice to the phone of `handle`.
    async fn notice(
        &self,
        handle: &str,
        headers: &HeaderMap,
        body: Incoming,
    ) -> Response<Full<Bytes>> {
        let Some(body) = read(body, wire::MAX_NOTICE).await else {
            return answer(
                413,
                "a notice is one Web Push message of at most 4096 bytes",
            );
        };
        if !wire::web_push(&body) {
            return answer(400, "not a Web Push message: one aes128gcm record");
        }
        let Some(ttl) = wire::ttl_of(headers) else {
            return answer(400, "a notice says how long it may wait (TTL)");
        };
        let (sender, at) = match wire::sender_of(headers, handle, &body, now_ms()) {
            Ok(signed) => signed,
            Err(e) => return answer(401, &format!("{e:#}")),
        };
        // A phone unknown here and one that did not name the sender are answered alike.
        let Some(phone) = self
            .inner
            .store
            .get(handle)
            .filter(|p| p.senders.contains(&sender))
        else {
            return answer(404, "no phone is told here at that address");
        };
        if !self.inner.by_phone.allow(handle.to_string()) {
            return answer(429, "too many notices: wait a little");
        }
        if !self.first(&sender, at, &body) {
            return answer(409, "that notice was passed on before");
        }
        match self.pass_on(&phone, &body, ttl, Urgency::of(headers)).await {
            Passed::Delivered => json_answer(201, json!({})),
            Passed::Gone => {
                if let Err(e) = self.inner.store.drop_gone(handle, &phone) {
                    eprintln!("hive-net: push: {e:#}");
                }
                answer(410, "the phone is told here no more")
            }
            Passed::TooLarge => answer(413, "too large for the phone's service"),
            Passed::Failed(_) => answer(502, "the phone's service did not take it"),
        }
    }
}

fn json_answer(status: u16, body: Value) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(body.to_string())))
        .expect("a response is well formed")
}

fn answer(status: u16, error: &str) -> Response<Full<Bytes>> {
    json_answer(status, json!({ "error": error }))
}

/// `body` whole, when it is at most `most` bytes and comes within [`BODY_PATIENCE`].
async fn read(body: Incoming, most: usize) -> Option<Bytes> {
    let collected = tokio::time::timeout(BODY_PATIENCE, Limited::new(body, most).collect()).await;
    collected.ok()?.ok().map(|c| c.to_bytes())
}

/// Send `out` with `client`, once more after a moment when the service is busy or failing (429,
/// 5xx) or not reached: its status, and at most [`MAX_ANSWER`] bytes of its answer when `read`.
async fn send(client: &reqwest::Client, out: &Outgoing, read: bool) -> Result<(u16, String)> {
    let once = || async {
        let mut request = client.post(&out.url).body(out.body.clone());
        for (name, value) in &out.headers {
            request = request.header(*name, value);
        }
        // The address is the phone's: it goes in no error.
        let response = request.send().await.map_err(reqwest::Error::without_url)?;
        let status = response.status().as_u16();
        let after = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok())
            .map(Duration::from_secs);
        let text = if read {
            answer_of(response).await
        } else {
            String::new()
        };
        Ok::<_, anyhow::Error>((status, after, text))
    };
    let pause = |after: Option<Duration>| {
        let jitter = Duration::from_millis(rand::random::<u64>() % 250);
        after
            .unwrap_or(Duration::from_millis(500))
            .min(Duration::from_secs(2))
            + jitter
    };
    match once().await {
        Ok((status, after, _)) if status == 429 || status >= 500 => {
            tokio::time::sleep(pause(after)).await;
        }
        Ok((status, _, text)) => return Ok((status, text)),
        Err(_) => tokio::time::sleep(pause(None)).await,
    }
    once().await.map(|(status, _, text)| (status, text))
}

/// At most [`MAX_ANSWER`] bytes of what `response` says, as text.
pub(crate) async fn answer_of(mut response: reqwest::Response) -> String {
    let mut text = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        text.extend_from_slice(&chunk[..chunk.len().min(MAX_ANSWER - text.len())]);
        if text.len() >= MAX_ANSWER {
            break;
        }
    }
    String::from_utf8_lossy(&text).into_owned()
}
