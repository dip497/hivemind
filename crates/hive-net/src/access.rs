//! The access role (R16, spec/network-access.md): who may use a network's relays. A device is
//! allowed while it is enrolled (by the admin, or by an enrolled device), registered (an
//! `open-pow` network: it proved its key and did a little work) or visiting (until the voucher
//! that admitted it expires). Every change is signed, so there are no accounts; what is allowed
//! is kept in one file, and nothing else is. A relay beside it asks it about each device that
//! connects (`AccessControl`); a relay elsewhere asks over HTTP (`GET /allowed/<id>`, `Remote`),
//! as a stock relay can. `serve.rs` serves its requests under `/access`.

use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
    str::FromStr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use anyhow::{bail, ensure, Context, Result};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{body::Incoming, Request, Response};
use iroh::{PublicKey, SecretKey};
use iroh_relay::server::{Access, AccessControl, ClientRequest};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    egress,
    profile::Policy,
    signed::{self, key_of, now_ms, verify},
    state_file,
};

const VOUCHER: &[u8] = b"hive/voucher/1\n";
const REDEEM: &[u8] = b"hive/redeem/1\n";
const REGISTER: &[u8] = b"hive/register/1\n";
const REVOKE: &[u8] = b"hive/revoke/1\n";
/// The largest request body the service reads.
const MAX_BODY: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// For good, until revoked.
    Enrol,
    /// Until the voucher expires.
    Visit,
}

/// A signed, time-limited, counted admission.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Voucher {
    pub v: u32,
    pub kind: Kind,
    pub by: String,
    pub device: Option<String>,
    pub nonce: String,
    pub expires: u64,
    pub uses: u32,
    pub signature: String,
}

impl Voucher {
    /// A voucher of `kind`, signed by `by`, for `device` (none: whoever redeems it), until
    /// `expires`, redeemed at most `uses` times.
    pub fn new(
        kind: Kind,
        by: &SecretKey,
        device: Option<PublicKey>,
        expires: u64,
        uses: u32,
    ) -> Self {
        let mut v = Voucher {
            v: 1,
            kind,
            by: by.public().to_string(),
            device: device.map(|d| d.to_string()),
            nonce: hex::encode(rand::random::<[u8; 16]>()),
            expires,
            uses,
            signature: String::new(),
        };
        v.signature = hex::encode(
            by.sign(&v.bytes().expect("a voucher made here is well formed"))
                .to_bytes(),
        );
        v
    }

    fn bytes(&self) -> Result<Vec<u8>> {
        let by = key_of(&self.by)?;
        let device = match &self.device {
            Some(d) => *key_of(d)?.as_bytes(),
            None => [0u8; 32],
        };
        let mut nonce = [0u8; 16];
        hex::decode_to_slice(&self.nonce, &mut nonce).context("a nonce is 16 bytes in hex")?;
        let mut out = VOUCHER.to_vec();
        out.push(match self.kind {
            Kind::Enrol => 0,
            Kind::Visit => 1,
        });
        out.extend_from_slice(by.as_bytes());
        out.extend_from_slice(&device);
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&self.expires.to_be_bytes());
        out.extend_from_slice(&self.uses.to_be_bytes());
        Ok(out)
    }

    /// Who signed it, if the signature verifies and it has not expired.
    fn check(&self, now: u64) -> Result<PublicKey> {
        ensure!(
            self.v == 1,
            "a voucher of version {} is not one this reads",
            self.v
        );
        let by = key_of(&self.by)?;
        verify(&by, &self.bytes()?, &self.signature).context("the voucher is not its signer's")?;
        ensure!(self.expires > now, "the voucher has expired");
        Ok(by)
    }
}

fn redeem_bytes(nonce: &str, device: &PublicKey) -> Result<Vec<u8>> {
    let mut n = [0u8; 16];
    hex::decode_to_slice(nonce, &mut n).context("a nonce is 16 bytes in hex")?;
    Ok([REDEEM, &n, device.as_bytes()].concat())
}

fn register_bytes(device: &PublicKey, at: u64, nonce: u64) -> Vec<u8> {
    [
        REGISTER,
        device.as_bytes(),
        &at.to_be_bytes(),
        &nonce.to_be_bytes(),
    ]
    .concat()
}

fn revoke_bytes(by: &PublicKey, device: &PublicKey, at: u64) -> Vec<u8> {
    [REVOKE, by.as_bytes(), device.as_bytes(), &at.to_be_bytes()].concat()
}

fn leading_zero_bits(hash: &[u8]) -> u32 {
    let mut bits = 0;
    for b in hash {
        if *b == 0 {
            bits += 8;
        } else {
            return bits + b.leading_zeros();
        }
    }
    bits
}

/// A visit: until when, and who vouched for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Visit {
    until: u64,
    by: String,
}

/// What the service allows, as kept on disk.
#[derive(Debug, Default, Serialize, Deserialize)]
struct State {
    enrolled: BTreeMap<String, u64>,
    registered: BTreeMap<String, u64>,
    visiting: BTreeMap<String, Visit>,
    /// How often each bearer voucher, by nonce, was redeemed.
    redeemed: BTreeMap<String, u32>,
}

/// The access service: one per network, beside its relays.
#[derive(Debug, Clone)]
pub struct Service {
    state: Arc<Mutex<State>>,
    file: PathBuf,
    admin: PublicKey,
    policy: Policy,
    bits: u32,
}

impl Service {
    /// The service for the network `admin` runs, under `policy`, keeping what it allows in `dir`;
    /// registering asks for `bits` leading zero bits of work.
    pub fn open(dir: &Path, admin: PublicKey, policy: Policy, bits: u32) -> Result<Self> {
        fs::create_dir_all(dir).with_context(|| format!("cannot make {}", dir.display()))?;
        let file = dir.join("access.json");
        let state = state_file::read(&file)?;
        Ok(Self {
            state: Arc::new(Mutex::new(state)),
            file,
            admin,
            policy,
            bits,
        })
    }

    /// Whether `device` may use the relays now.
    pub fn allowed(&self, device: &PublicKey) -> bool {
        let id = device.to_string();
        let state = self.state.lock().unwrap();
        state.enrolled.contains_key(&id)
            || (self.policy == Policy::OpenPow && state.registered.contains_key(&id))
            || state.visiting.get(&id).is_some_and(|v| v.until > now_ms())
    }

    fn save(&self, state: &State) -> Result<()> {
        state_file::write(&self.file, state)
    }

    /// Whether `by` may sign a voucher of `kind` here.
    fn may_vouch(&self, state: &State, by: &PublicKey, kind: Kind) -> bool {
        let id = by.to_string();
        *by == self.admin
            || state.enrolled.contains_key(&id)
            || (kind == Kind::Visit
                && self.policy == Policy::OpenPow
                && state.registered.contains_key(&id))
    }

    fn admit(state: &mut State, device: &PublicKey, voucher: &Voucher) {
        match voucher.kind {
            Kind::Enrol => {
                state.enrolled.insert(device.to_string(), now_ms());
            }
            Kind::Visit => {
                state.visiting.insert(
                    device.to_string(),
                    Visit {
                        until: voucher.expires,
                        by: voucher.by.clone(),
                    },
                );
            }
        }
    }

    /// A voucher that names its device, given by its signer.
    pub fn vouch(&self, voucher: &Voucher) -> Result<()> {
        let by = voucher.check(now_ms())?;
        let device = key_of(
            voucher
                .device
                .as_deref()
                .context("a voucher given to the service names its device")?,
        )?;
        let mut state = self.state.lock().unwrap();
        ensure!(
            self.may_vouch(&state, &by, voucher.kind),
            "{by} may not vouch here"
        );
        Self::admit(&mut state, &device, voucher);
        self.save(&state)
    }

    /// A voucher that names no device, redeemed by `device`, which proves it holds its key.
    pub fn redeem(&self, voucher: &Voucher, device: &PublicKey, proof: &str) -> Result<()> {
        let by = voucher.check(now_ms())?;
        ensure!(
            voucher.device.is_none(),
            "that voucher is for one device, given by its signer"
        );
        verify(device, &redeem_bytes(&voucher.nonce, device)?, proof)
            .context("the device did not prove its key")?;
        let mut state = self.state.lock().unwrap();
        ensure!(
            self.may_vouch(&state, &by, voucher.kind),
            "{by} may not vouch here"
        );
        let used = state.redeemed.get(&voucher.nonce).copied().unwrap_or(0);
        ensure!(used < voucher.uses, "the voucher was used up");
        state.redeemed.insert(voucher.nonce.clone(), used + 1);
        Self::admit(&mut state, device, voucher);
        self.save(&state)
    }

    /// A device registering on an `open-pow` network.
    pub fn register(&self, device: &PublicKey, at: u64, nonce: u64, signature: &str) -> Result<()> {
        ensure!(
            self.policy == Policy::OpenPow,
            "this network does not take registrations"
        );
        ensure!(
            signed::near(at, now_ms()),
            "the registration's time is too far from now"
        );
        let bytes = register_bytes(device, at, nonce);
        ensure!(
            leading_zero_bits(&Sha256::digest(&bytes)) >= self.bits,
            "not enough work"
        );
        verify(device, &bytes, signature).context("the device did not prove its key")?;
        let mut state = self.state.lock().unwrap();
        state.registered.insert(device.to_string(), now_ms());
        self.save(&state)
    }

    /// `by` takes `device`'s admission back: the admin anyone's, a device a visit it vouched for.
    pub fn revoke(
        &self,
        device: &PublicKey,
        by: &PublicKey,
        at: u64,
        signature: &str,
    ) -> Result<()> {
        ensure!(
            signed::near(at, now_ms()),
            "the revocation's time is too far from now"
        );
        verify(by, &revoke_bytes(by, device, at), signature)?;
        let id = device.to_string();
        let mut state = self.state.lock().unwrap();
        if *by == self.admin {
            state.enrolled.remove(&id);
            state.registered.remove(&id);
            state.visiting.remove(&id);
        } else {
            ensure!(
                state
                    .visiting
                    .get(&id)
                    .is_some_and(|v| v.by == by.to_string()),
                "{by} did not vouch for {id}"
            );
            state.visiting.remove(&id);
        }
        self.save(&state)
    }

    fn apply(&self, path: &str, body: &Value) -> Result<()> {
        let field = |name: &str| body.get(name).context(format!("{name} is missing"));
        let text = |name: &str| -> Result<String> {
            Ok(field(name)?
                .as_str()
                .context(format!("{name} is not text"))?
                .to_string())
        };
        let number = |name: &str| -> Result<u64> {
            field(name)?
                .as_u64()
                .context(format!("{name} is not a number"))
        };
        match path {
            "/vouch" => self.vouch(&serde_json::from_value(body.clone()).context("not a voucher")?),
            "/redeem" => self.redeem(
                &serde_json::from_value(field("voucher")?.clone()).context("not a voucher")?,
                &key_of(&text("device")?)?,
                &text("proof")?,
            ),
            "/register" => self.register(
                &key_of(&text("device")?)?,
                number("at")?,
                number("nonce")?,
                &text("signature")?,
            ),
            "/revoke" => self.revoke(
                &key_of(&text("device")?)?,
                &key_of(&text("by")?)?,
                number("at")?,
                &text("signature")?,
            ),
            _ => bail!("no such request"),
        }
    }

    /// Answer one request, its path relative to the service's URL.
    pub(crate) async fn handle(&self, req: Request<Incoming>) -> Response<Full<Bytes>> {
        let answer = |status: u16, body: String| {
            Response::builder()
                .status(status)
                .header(
                    "content-type",
                    if body.starts_with('{') {
                        "application/json"
                    } else {
                        "text/plain"
                    },
                )
                .body(Full::new(Bytes::from(body)))
                .expect("a response is well formed")
        };
        let (parts, body) = req.into_parts();
        let path = parts.uri.path().to_string();
        match (parts.method.as_str(), path.as_str()) {
            ("GET", "/healthz") => answer(200, "ok".into()),
            ("GET", "/pow") => answer(200, json!({ "bits": self.bits }).to_string()),
            ("GET", p) if p.starts_with("/allowed/") => {
                let allowed =
                    PublicKey::from_str(&p["/allowed/".len()..]).is_ok_and(|k| self.allowed(&k));
                answer(200, allowed.to_string())
            }
            ("POST", "/vouch" | "/redeem" | "/register" | "/revoke") => {
                let read = Limited::new(body, MAX_BODY).collect().await;
                let parsed = match read {
                    Ok(collected) => {
                        serde_json::from_slice::<Value>(&collected.to_bytes()).context("not JSON")
                    }
                    Err(_) => Err(anyhow::anyhow!("the request is too large")),
                };
                match parsed.and_then(|v| self.apply(&path, &v)) {
                    Ok(()) => answer(200, json!({ "ok": true }).to_string()),
                    Err(e) => answer(403, json!({ "error": format!("{e:#}") }).to_string()),
                }
            }
            _ => answer(404, "not found".into()),
        }
    }
}

impl AccessControl for Service {
    async fn on_connect(&self, request: &ClientRequest) -> Access {
        if self.allowed(&request.endpoint_id()) {
            Access::Allow
        } else {
            Access::Deny {
                reason: Some("not allowed on this network".into()),
            }
        }
    }
}

/// How long a relay keeps a "yes" from an access service elsewhere (§12.1): a short outage of the
/// service locks nobody out who was let in, and a revocation takes this long to reach the relay.
pub const REMEMBER: Duration = Duration::from_secs(5 * 60);
/// How long it keeps a "no": short, so a device let in just after it was turned away (one that
/// connected while it registered) is soon let in, and a crowd of strangers asks the service only
/// this often each.
pub const REMEMBER_NO: Duration = Duration::from_secs(10);

/// The access role, asked by a relay that runs apart from it (§12.1: the hosted network's relays
/// ask its access service): `GET <access>/allowed/<id>`, a yes kept for [`REMEMBER`] (or what the
/// relay's operator chose) and a no for [`REMEMBER_NO`]. While the service does not answer, a yes kept from before still stands,
/// however old; a device it never said yes to is refused.
#[derive(Debug, Clone)]
pub struct Remote {
    url: String,
    http: reqwest::Client,
    answers: Arc<Mutex<HashMap<PublicKey, (bool, Instant)>>>,
    /// How long a yes is kept ([`REMEMBER`], unless the relay's operator says otherwise).
    remember: Duration,
}

impl Remote {
    pub fn new(url: &str, remember: Duration) -> Result<Self> {
        Ok(Self {
            url: url.trim_end_matches('/').to_string(),
            http: egress::trusted()?,
            answers: Arc::default(),
            remember,
        })
    }

    async fn ask(&self, device: &PublicKey) -> Result<bool> {
        let response = self
            .http
            .get(format!("{}/allowed/{device}", self.url))
            .timeout(Duration::from_secs(10))
            .send()
            .await?;
        ensure!(
            response.status().is_success(),
            "{} answered {}",
            self.url,
            response.status()
        );
        Ok(response.text().await?.trim() == "true")
    }
}

impl AccessControl for Remote {
    async fn on_connect(&self, request: &ClientRequest) -> Access {
        let device = request.endpoint_id();
        let kept = self.answers.lock().unwrap().get(&device).copied();
        let fresh = |allowed: bool, at: Instant| {
            at.elapsed()
                < if allowed {
                    self.remember
                } else {
                    REMEMBER_NO.min(self.remember)
                }
        };
        let allowed = match kept {
            Some((allowed, at)) if fresh(allowed, at) => allowed,
            _ => match self.ask(&device).await {
                Ok(allowed) => {
                    self.answers
                        .lock()
                        .unwrap()
                        .insert(device, (allowed, Instant::now()));
                    allowed
                }
                Err(_) => kept.is_some_and(|(allowed, _)| allowed),
            },
        };
        if allowed {
            Access::Allow
        } else {
            Access::Deny {
                reason: Some("not allowed on this network".into()),
            }
        }
    }
}

/// A device asking a network's access service, as the app and the admin's command line do.
pub mod client {
    use super::*;

    fn at(access: &str, path: &str) -> String {
        format!("{}{path}", access.trim_end_matches('/'))
    }

    async fn post(access: &str, path: &str, body: Value) -> Result<()> {
        let response = egress::trusted()?
            .post(at(access, path))
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .with_context(|| format!("cannot reach {access}"))?;
        if response.status().is_success() {
            return Ok(());
        }
        let text = response.text().await.unwrap_or_default();
        let why = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v["error"].as_str().map(str::to_string))
            .unwrap_or(text);
        bail!("{access} refused: {why}")
    }

    /// Give the service a voucher that names its device.
    pub async fn vouch(access: &str, voucher: &Voucher) -> Result<()> {
        post(access, "/vouch", serde_json::to_value(voucher)?).await
    }

    /// Redeem a voucher that names no device, as `key`'s device.
    pub async fn redeem(access: &str, voucher: &Voucher, key: &SecretKey) -> Result<()> {
        let device = key.public();
        let proof = hex::encode(key.sign(&redeem_bytes(&voucher.nonce, &device)?).to_bytes());
        post(
            access,
            "/redeem",
            json!({ "voucher": voucher, "device": device.to_string(), "proof": proof }),
        )
        .await
    }

    /// Register `key`'s device on an `open-pow` network: the work it asks for, then the request.
    pub async fn register(access: &str, key: &SecretKey) -> Result<()> {
        let bits: Value = serde_json::from_str(
            &egress::trusted()?
                .get(at(access, "/pow"))
                .send()
                .await
                .with_context(|| format!("cannot reach {access}"))?
                .text()
                .await?,
        )?;
        let bits = bits["bits"]
            .as_u64()
            .context("the service did not say how much work")? as u32;
        let device = key.public();
        let at_ms = now_ms();
        let nonce = (0u64..)
            .find(|n| {
                leading_zero_bits(&Sha256::digest(register_bytes(&device, at_ms, *n))) >= bits
            })
            .expect("some nonce does the work");
        let signature = hex::encode(key.sign(&register_bytes(&device, at_ms, nonce)).to_bytes());
        post(access, "/register", json!({ "device": device.to_string(), "at": at_ms, "nonce": nonce, "signature": signature })).await
    }

    /// Take `device`'s admission back, as `by`.
    pub async fn revoke(access: &str, device: &PublicKey, by: &SecretKey) -> Result<()> {
        let at_ms = now_ms();
        let signature = hex::encode(
            by.sign(&revoke_bytes(&by.public(), device, at_ms))
                .to_bytes(),
        );
        post(access, "/revoke", json!({ "device": device.to_string(), "by": by.public().to_string(), "at": at_ms, "signature": signature })).await
    }
}
