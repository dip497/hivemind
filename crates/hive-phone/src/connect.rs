//! The phone's side of connecting (spec/pairing.md 0.10): it scans an app's offer, asks with it,
//! shows the words both screens show, and waits on the person at the app. Told it is theirs, it
//! takes the certificate the app gives only once its own person says the words match; otherwise it
//! keeps nothing. Held to `conformance/pairing.json`.

use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, KeyInit, Mac};
use iroh::{Endpoint, EndpointAddr};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::Sha256;

use crate::{
    failure::Failure,
    identity::{is_hex, DeviceCertificate, Identity},
    now_ms,
    pairing::{
        admission_of, is_space, name_of, parse_code, reached, reached_of, Admission, Paired,
        PairedWith, WORDS,
    },
    person::{read_profile, Person},
};

const PREFIX: &str = "hivemind://connect/";

/// How long the app has to answer an ask, a take or a refuse.
const ANSWER_WITHIN: Duration = Duration::from_secs(60);
/// How long the phone waits on the person at the app: the app answers within 170 s of the ask.
const WAIT_WITHIN: Duration = Duration::from_secs(180);

fn mac(code: &str, message: &str) -> Hmac<Sha256> {
    let mut mac = Hmac::<Sha256>::new_from_slice(code.as_bytes()).expect("HMAC takes any key");
    mac.update(message.as_bytes());
    mac
}

fn proof_mac(code: &str, label: &str, offering: &str, entering: &str) -> Hmac<Sha256> {
    mac(
        code,
        &format!("hive/connect/1 {label}\n{offering}{entering}"),
    )
}

/// A proof of holding `code`, good only between the devices `offering` and `entering`.
pub fn proof(code: &str, label: &str, offering: &str, entering: &str) -> String {
    hex::encode(
        proof_mac(code, label, offering, entering)
            .finalize()
            .into_bytes(),
    )
}

/// Whether `given` is the proof, compared in constant time.
fn proven(given: Option<&str>, code: &str, label: &str, offering: &str, entering: &str) -> bool {
    let Some(bytes) = given
        .filter(|g| is_hex(g, 64))
        .and_then(|g| hex::decode(g).ok())
    else {
        return false;
    };
    proof_mac(code, label, offering, entering)
        .verify_slice(&bytes)
        .is_ok()
}

/// The words both screens show for one request.
pub fn words(
    code: &str,
    offering: &str,
    entering: &str,
    nonce_o: &str,
    nonce_j: &str,
) -> Vec<String> {
    let made = mac(
        code,
        &format!("hive/connect/1 words\n{offering}{entering}{nonce_o}{nonce_j}"),
    )
    .finalize()
    .into_bytes();
    made[..3]
        .iter()
        .map(|b| WORDS[*b as usize].clone())
        .collect()
}

/// An app's offer, as its link carries it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectLink {
    pub device: String,
    pub addrs: Vec<String>,
    pub relay: Option<String>,
    pub code: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admission: Option<Admission>,
}

/// The offer `text` is a link to (or the phone page's address carrying one), or none.
pub fn parse_link(text: &str) -> Option<ConnectLink> {
    let text = text.trim_matches(is_space);
    match text.split_once('#') {
        Some((page, fragment)) if page.starts_with("https://") || page.starts_with("http://") => {
            let (_, link) =
                form_urlencoded::parse(fragment.as_bytes()).find(|(k, _)| k == "connect")?;
            link_of(link.trim_matches(is_space))
        }
        _ => link_of(text),
    }
}

fn link_of(text: &str) -> Option<ConnectLink> {
    let (device, body) = text.strip_prefix(PREFIX)?.split_once('#')?;
    let base64url = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
    if !is_hex(device, 64) || body.is_empty() || !body.chars().all(base64url) {
        return None;
    }
    let l: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(body).ok()?).ok()?;
    let l = l.as_object()?;
    if l.get("v").and_then(Value::as_f64) != Some(1.0) {
        return None;
    }
    let code = parse_code(l.get("code")?.as_str()?)?;
    let name = name_of(l.get("name"))?;
    let (addrs, relay) = reached_of(l);
    Some(ConnectLink {
        device: device.to_string(),
        addrs,
        relay,
        code,
        name,
        admission: admission_of(l.get("admission")),
    })
}

/// What the phone `me` sends the app whose offer `link` it scanned, with its own `nonce`.
pub fn ask(
    me: &str,
    name: &str,
    addrs: &[String],
    relay: Option<&str>,
    link: &ConnectLink,
    nonce: &str,
) -> Value {
    json!({
        "v": 1, "connect": "ask", "proof": proof(&link.code, "entering", &link.device, me),
        "nonce": nonce, "name": name, "kind": "phone", "addrs": addrs, "relay": relay,
    })
}

/// Why the app said no, as the phone's person is told.
fn refusal(error: Option<&str>) -> String {
    match error {
        Some("expired") => {
            "that offer has expired, or was used: show a new one on the computer".into()
        }
        Some("wrong-code") => "the computer has a different code: scan the one it shows now".into(),
        Some("busy") => {
            "the computer has requests waiting already: try again in a few minutes".into()
        }
        Some("declined") => "the computer did not let this phone in".into(),
        Some("malformed") => {
            "the computer did not understand this phone: update hivemind there".into()
        }
        Some(other) => format!("the computer refused: {other}"),
        None => "the computer refused".into(),
    }
}

/// `answer`, when the app said yes to what was asked; its refusal otherwise.
fn granted(answer: &Value) -> Result<&Map<String, Value>> {
    let a = answer.as_object().context("the computer did not answer")?;
    if a.get("ok").and_then(Value::as_bool) != Some(true) {
        let error = a.get("error").and_then(Value::as_str);
        return Err(Failure::Refused {
            code: error.map(str::to_string),
            message: refusal(error),
        }
        .into());
    }
    Ok(a)
}

fn malformed() -> anyhow::Error {
    anyhow!("the computer's answer did not check out")
}

/// An offer asked with: the request the app keeps, the words both screens show, and the app, as
/// the phone keeps it once it is the person's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asked {
    pub request: String,
    pub words: Vec<String>,
    pub with: PairedWith,
}

/// The app's `answer` to the ask the phone `me` made with `link` and `nonce`: what the phone shows,
/// once the app proved it holds the code and its certificate names it.
pub fn asked(me: &str, link: &ConnectLink, nonce: &str, answer: &Value) -> Result<Asked> {
    let a = granted(answer)?;
    if !proven(
        a.get("proof").and_then(Value::as_str),
        &link.code,
        "offering",
        &link.device,
        me,
    ) {
        bail!("the device answering does not hold this code");
    }
    let request = a
        .get("request")
        .and_then(Value::as_str)
        .filter(|r| is_hex(r, 16))
        .ok_or_else(malformed)?;
    let theirs = a
        .get("nonce")
        .and_then(Value::as_str)
        .filter(|n| is_hex(n, 32))
        .ok_or_else(malformed)?;
    let name = name_of(a.get("name")).ok_or_else(malformed)?;
    let certificate = a
        .get("certificate")
        .and_then(DeviceCertificate::verified)
        .filter(|c| c.device == link.device)
        .ok_or_else(malformed)?;
    let (addrs, relay) = reached_of(a);
    Ok(Asked {
        request: request.to_string(),
        words: words(&link.code, &link.device, me, theirs, nonce),
        with: PairedWith {
            device: link.device.clone(),
            name,
            kind: "app".into(),
            certificate,
            addrs,
            relay,
        },
    })
}

/// What the person at the app answered: that the phone is theirs, as their profile says them (none
/// when it says nothing that can be shown). A phone is never let in as someone else.
pub fn told(answer: &Value) -> Result<Option<Person>> {
    let a = granted(answer)?;
    if a.get("as").and_then(Value::as_str) != Some("me") {
        return Err(malformed());
    }
    Ok(a.get("profile").and_then(read_profile))
}

/// What the app gave the phone `me` that took the person `asked` was answered for: the certificate
/// naming it as the person whose the app is, and the app's network when it verifies.
pub fn taken(me: &str, asked: &Asked, answer: &Value) -> Result<Paired> {
    let a = granted(answer)?;
    let yours = a
        .get("yours")
        .and_then(DeviceCertificate::verified)
        .filter(|c| c.device == me && c.person == asked.with.certificate.person)
        .ok_or_else(malformed)?;
    let network = a
        .get("network")
        .and_then(Value::as_str)
        .filter(|n| crate::network::verified(n).is_some())
        .map(str::to_string);
    Ok(Paired {
        with: asked.with.clone(),
        certificate: yours,
        network,
    })
}

async fn within(
    time: Duration,
    asking: impl std::future::Future<Output = Result<Value>>,
) -> Result<Value> {
    n0_future::time::timeout(time, asking).await.map_err(|_| {
        Failure::Unreachable(
            "the computer did not answer: is it on this network, still showing the code?".into(),
        )
    })?
}

/// An offer this phone asked with, from an endpoint of its own, until it takes or refuses.
pub struct Connecting {
    endpoint: Endpoint,
    at: EndpointAddr,
    me: String,
    pub asked: Asked,
    /// `vouched for by the app`, `registered`, or `none needed`.
    pub admission: &'static str,
}

impl Identity {
    /// Ask with the offer `link`, as this phone called `name`: onto the app's network first, as its
    /// link says, then to the app, where the link says it is.
    pub async fn connect_with(&self, name: &str, link: &ConnectLink) -> Result<Connecting> {
        let admission = match &link.admission {
            Some(admission) => crate::network::admit(admission, self.key())
                .await
                .context("not let onto the app's network")?,
            None => "none needed",
        };
        let reach = self.reach_through(link.relay.as_deref());
        let endpoint = hive_net::net::endpoint(self.key().clone(), &reach, vec![]).await?;
        let asking = async {
            let me = endpoint.id().to_string();
            let (addrs, relay) = reached(&endpoint);
            let nonce = hex::encode(rand::random::<[u8; 16]>());
            let at = hive_net::net::addr_of(&link.device, &link.addrs, &link.relay)?;
            let hello = ask(&me, name, &addrs, relay.as_deref(), link, &nonce);
            let answer = within(
                ANSWER_WITHIN,
                hive_net::pair::ask(&endpoint, at.clone(), &hello),
            )
            .await?;
            Ok::<_, anyhow::Error>((asked(&me, link, &nonce, &answer)?, at, me))
        }
        .await;
        match asking {
            Ok((asked, at, me)) => Ok(Connecting {
                endpoint,
                at,
                me,
                asked,
                admission,
            }),
            Err(e) => {
                endpoint.close().await;
                Err(e)
            }
        }
    }
}

impl Connecting {
    async fn send(&self, time: Duration, connect: &str) -> Result<Value> {
        let hello = json!({ "v": 1, "connect": connect, "request": self.asked.request });
        within(
            time,
            hive_net::pair::ask(&self.endpoint, self.at.clone(), &hello),
        )
        .await
    }

    /// Wait on the person at the app: their profile, once they say this phone is theirs.
    pub async fn wait(&self) -> Result<Option<Person>> {
        told(&self.send(WAIT_WITHIN, "wait").await?)
    }

    /// The person here says the words match: take what the app gives, and keep it as `identity`'s,
    /// with the person's other devices the app tells of.
    pub async fn take(self, identity: &Identity) -> Result<Paired> {
        let taking = async {
            let paired = taken(
                &self.me,
                &self.asked,
                &self.send(ANSWER_WITHIN, "take").await?,
            )?;
            identity.keep(&paired, now_ms())?;
            let _ = identity.learn_from(&self.endpoint, now_ms()).await;
            Ok(paired)
        }
        .await;
        self.endpoint.close().await;
        taking
    }

    /// The person here says the words do not match: the app is told, and nothing is kept.
    pub async fn refuse(self) {
        let _ = self.send(ANSWER_WITHIN, "refuse").await;
        self.endpoint.close().await;
    }

    /// Stop asking, telling the app nothing: it answers no once nobody waits.
    pub async fn close(self) {
        self.endpoint.close().await;
    }
}
