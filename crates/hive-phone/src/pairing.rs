//! The phone's side of pairing (spec/pairing.md 0.3): it scans the link an app shows (Settings →
//! Devices), dials the app on `hive/pair/1`, proves it holds the code, and checks the app's proof
//! before it keeps anything. The app gives it a certificate naming it, signed by the person key;
//! the person key itself never comes to a phone. Held to `conformance/pairing.json`.

use std::{sync::LazyLock, time::Duration};

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, KeyInit, Mac};
use iroh::{Endpoint, TransportAddr};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::Sha256;

use crate::identity::{is_hex, DeviceCertificate};

/// The 256 words a code is made of (spec/pairing-words.json).
static WORDS: LazyLock<Vec<String>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../spec/pairing-words.json"))
        .expect("the words are a list of text")
});
const CODE_WORDS: usize = 6;
const LINK_PREFIX: &str = "hivemind://pair/";

/// How long the app has to answer.
const ANSWER_WITHIN: Duration = Duration::from_secs(60);

/// Spaces, as the app splits and trims text (JavaScript's `\s`).
fn is_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// Text's length as the app counts it (UTF-16 units).
fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The code in `text` — its six words in order, separated by spaces or hyphens, in any case — or
/// none when it is not one.
pub fn parse_code(text: &str) -> Option<String> {
    let lower = text.trim_matches(is_space).to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| is_space(c) || c == '-')
        .filter(|w| !w.is_empty())
        .collect();
    (words.len() == CODE_WORDS && words.iter().all(|w| WORDS.iter().any(|x| x == w)))
        .then(|| words.join("-"))
}

/// A proof of holding `code`, good only between the devices `offering` and `entering`.
pub fn proof(code: &str, label: &str, offering: &str, entering: &str) -> String {
    hex::encode(mac(code, label, offering, entering).finalize().into_bytes())
}

fn mac(code: &str, label: &str, offering: &str, entering: &str) -> Hmac<Sha256> {
    let mut mac = Hmac::<Sha256>::new_from_slice(code.as_bytes()).expect("HMAC takes any key");
    mac.update(format!("hive/pair/1 {label}\n{offering}{entering}").as_bytes());
    mac
}

/// Whether `given` is the proof, compared in constant time.
fn proven(given: Option<&str>, code: &str, label: &str, offering: &str, entering: &str) -> bool {
    let Some(bytes) = given
        .filter(|g| is_hex(g, 64))
        .and_then(|g| hex::decode(g).ok())
    else {
        return false;
    };
    mac(code, label, offering, entering)
        .verify_slice(&bytes)
        .is_ok()
}

/// A device's name, as another will list it: text, not too long.
fn name_of(v: Option<&Value>) -> Option<String> {
    let text = v?.as_str()?;
    let name = text.trim_matches(is_space);
    (!name.is_empty() && units(text) <= 200).then(|| name.to_string())
}

/// Where a message says its device is reached: a few addresses, and a relay or none.
fn reached_of(m: &Map<String, Value>) -> (Vec<String>, Option<String>) {
    let addrs = m
        .get("addrs")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .filter(|a| units(a) <= 100)
                .take(16)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let relay = m
        .get("relay")
        .and_then(Value::as_str)
        .filter(|r| units(r) <= 500)
        .map(str::to_string);
    (addrs, relay)
}

/// A code and where the device offering it is, as its link carries them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairLink {
    pub device: String,
    pub addrs: Vec<String>,
    pub relay: Option<String>,
    pub code: String,
    pub name: String,
    /// The offering device's: `app` or `host`.
    pub kind: String,
}

/// The link in `text`, or none when it is not a pairing link.
pub fn parse_link(text: &str) -> Option<PairLink> {
    let body = text.trim_matches(is_space).strip_prefix(LINK_PREFIX)?;
    let l: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(body).ok()?).ok()?;
    let l = l.as_object()?;
    let device = l.get("device")?.as_str().filter(|d| is_hex(d, 64))?;
    let code = parse_code(l.get("code")?.as_str()?)?;
    let name = name_of(l.get("name"))?;
    let kind = l
        .get("kind")?
        .as_str()
        .filter(|k| matches!(*k, "app" | "host"))?;
    if l.get("v").and_then(Value::as_f64) != Some(1.0) {
        return None;
    }
    let (addrs, relay) = reached_of(l);
    Some(PairLink {
        device: device.to_string(),
        addrs,
        relay,
        code,
        name,
        kind: kind.to_string(),
    })
}

/// What the phone sends the app whose `link` it scanned: that it, the device `me`, holds the code;
/// its name; and where it is reached.
pub fn prove(
    me: &str,
    name: &str,
    addrs: &[String],
    relay: Option<&str>,
    link: &PairLink,
) -> Value {
    json!({
        "v": 1, "pair": "prove", "proof": proof(&link.code, "entering", &link.device, me),
        "name": name, "kind": "phone", "addrs": addrs, "relay": relay,
    })
}

/// One of the person's devices, as the phone keeps it (as the app keeps its own, `devices.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedWith {
    pub device: String,
    pub name: String,
    pub kind: String,
    /// The certificate that names it as the person's.
    pub certificate: DeviceCertificate,
    pub addrs: Vec<String>,
    pub relay: Option<String>,
}

/// What pairing gave the phone: the app, and the certificate naming the phone as the person's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paired {
    pub with: PairedWith,
    pub certificate: DeviceCertificate,
    /// The network the app is on (0.5), as it gave it, when that verifies; none: the local one.
    pub network: Option<String>,
}

/// Why the app said no, as the phone's person is told.
fn refusal(error: Option<&str>) -> String {
    match error {
        Some("expired") => {
            "that code has expired, or was used: show a new one on the computer".into()
        }
        Some("wrong-code") => "the computer has a different code: scan the one it shows now".into(),
        Some("same-kind") => "a phone pairs with the app on a computer, not with a host".into(),
        Some("malformed") => {
            "the computer did not understand this phone: update hivemind there".into()
        }
        Some(other) => format!("the computer refused: {other}"),
        None => "the computer refused".into(),
    }
}

/// The app's `answer` to the phone `me`, which scanned `link`: what pairing gave, once the app has
/// proved it holds the code and the certificates it gives check out; anything else is refused and
/// nothing of it is kept.
pub fn accept(me: &str, link: &PairLink, answer: &Value) -> Result<Paired> {
    let a = answer.as_object().context("the computer did not answer")?;
    if a.get("ok").and_then(Value::as_bool) != Some(true) {
        bail!(refusal(a.get("error").and_then(Value::as_str)));
    }
    let proof = a.get("proof").and_then(Value::as_str);
    if !proven(proof, &link.code, "offering", &link.device, me) {
        bail!("the device answering does not hold this code");
    }
    let malformed = || anyhow::anyhow!("the computer's answer did not check out");
    let name = name_of(a.get("name")).ok_or_else(malformed)?;
    if a.get("kind").and_then(Value::as_str) != Some("app") {
        bail!("a phone pairs with the app on a computer alone");
    }
    // The app is the person's, and the certificate it gives names this phone as that person's.
    let theirs = a
        .get("certificate")
        .and_then(DeviceCertificate::verified)
        .filter(|c| c.device == link.device)
        .ok_or_else(malformed)?;
    let yours = a
        .get("yours")
        .and_then(DeviceCertificate::verified)
        .filter(|c| c.device == me && c.person == theirs.person)
        .ok_or_else(malformed)?;
    let (addrs, relay) = reached_of(a);
    // Its network, taken only when it verifies.
    let network = a
        .get("network")
        .and_then(Value::as_str)
        .filter(|n| crate::network::verified(n).is_some())
        .map(str::to_string);
    Ok(Paired {
        with: PairedWith {
            device: link.device.clone(),
            name,
            kind: "app".into(),
            certificate: theirs,
            addrs,
            relay,
        },
        certificate: yours,
        network,
    })
}

/// Pair with the app whose `link` was scanned, from this phone's `endpoint`, as `name`.
pub async fn pair(endpoint: &Endpoint, name: &str, link: &PairLink) -> Result<Paired> {
    let me = endpoint.id().to_string();
    let here = endpoint.addr();
    let addrs: Vec<String> = here
        .addrs
        .iter()
        .filter_map(|a| match a {
            TransportAddr::Ip(ip) => Some(ip.to_string()),
            _ => None,
        })
        .collect();
    let relay = here.addrs.iter().find_map(|a| match a {
        TransportAddr::Relay(url) => Some(url.to_string()),
        _ => None,
    });
    let hello = prove(&me, name, &addrs, relay.as_deref(), link);
    let at = hive_net::net::addr_of(&link.device, &link.addrs, &link.relay)?;
    let answer = tokio::time::timeout(ANSWER_WITHIN, hive_net::pair::ask(endpoint, at, &hello))
        .await
        .map_err(|_| {
            anyhow::anyhow!(
                "the computer did not answer: is it on this network, still showing the code?"
            )
        })??;
    accept(&me, link, &answer)
}
