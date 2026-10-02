//! Network profiles (R16, spec/network-profile.md): where a network's servers are, in one file
//! signed by the network's admin key. The file is `{"profile": <text>, "signature": <hex>}`: the
//! profile is JSON text, and the signature is Ed25519 by the admin key over
//! `hive/network-profile/1\n` followed by the text's bytes, so nothing has to be canonicalised. A
//! link carries the file: `hivemind://network/<base64url of it>`. Two are built in and not signed:
//! *Local network* (no servers; the default) and *Hosted* (hivemind's, §12; used only once chosen).

use std::str::FromStr;

use anyhow::{bail, ensure, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use iroh::{PublicKey, RelayUrl, SecretKey, Signature};
use serde::{Deserialize, Serialize};

use crate::net::Reach;

/// What a profile's signature is over, before its text.
pub const DOMAIN: &[u8] = b"hive/network-profile/1\n";
/// How a link carrying a profile starts.
pub const LINK_PREFIX: &str = "hivemind://network/";

/// Who may use a network's relays (§12.3, §13.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Policy {
    /// Any device that registers its key with a small proof of work (our hosted network).
    OpenPow,
    /// Devices enrolled by the admin or by an enrolled device, and those vouched for.
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Relay {
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccessService {
    pub url: String,
    pub policy: Policy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushService {
    pub url: String,
    pub kinds: Vec<String>,
    /// Its VAPID key (RFC 8292), uncompressed, base64url: what a phone gives its UnifiedPush
    /// distributor, so the server may post there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vapid: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Local {
    /// Whether devices on the same network find each other by mDNS.
    #[serde(default = "yes")]
    pub mdns: bool,
}

impl Default for Local {
    fn default() -> Self {
        Self { mdns: true }
    }
}

fn yes() -> bool {
    true
}

/// A network's servers. A reader ignores fields it does not know (a minor version adds them).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub v: u32,
    pub name: String,
    #[serde(default)]
    pub relays: Vec<Relay>,
    #[serde(default)]
    pub lookup: Option<String>,
    #[serde(default)]
    pub access: Option<AccessService>,
    #[serde(default)]
    pub push: Option<PushService>,
    /// The admin's public key, in hex: it signs the profile, its updates and enrolments.
    #[serde(default)]
    pub admin: Option<String>,
    #[serde(default)]
    pub local: Local,
    #[serde(default)]
    pub issued_at: u64,
}

/// A signed profile file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Signed {
    pub profile: String,
    pub signature: String,
}

/// A profile this device may use: a built-in one, or one whose admin signed it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verified {
    pub profile: Profile,
    /// "local" or "hosted" for a built-in profile.
    pub builtin: Option<&'static str>,
    /// The admin key that signed it; none for a built-in profile.
    pub admin: Option<PublicKey>,
}

impl Profile {
    /// Check what a profile says, whoever signed it.
    fn check(&self) -> Result<()> {
        ensure!(
            self.v == 1,
            "a profile of version {} is not one this reads",
            self.v
        );
        ensure!(
            !self.name.trim().is_empty() && self.name.len() <= 64,
            "a profile names its network in 1 to 64 characters"
        );
        for relay in &self.relays {
            RelayUrl::from_str(&relay.url)
                .with_context(|| format!("{} is not a relay's URL", relay.url))?;
        }
        for url in self
            .lookup
            .iter()
            .chain(self.access.iter().map(|a| &a.url))
            .chain(self.push.iter().map(|p| &p.url))
        {
            ensure!(
                url.starts_with("https://") || url.starts_with("http://"),
                "{url} is not a server's URL"
            );
        }
        Ok(())
    }

    /// How a device on this network is reached: through its relays (none: the local network
    /// only), found by its id alone through its lookup server, and by mDNS among devices on the
    /// same network whatever else it names.
    pub fn reach(&self) -> Result<Reach> {
        Ok(Reach {
            relays: self
                .relays
                .iter()
                .map(|r| RelayUrl::from_str(&r.url))
                .collect::<Result<_, _>>()?,
            lookup: self
                .lookup
                .as_deref()
                .map(url::Url::parse)
                .transpose()
                .context("the lookup server's URL")?,
            mdns: self.local.mdns,
        })
    }
}

/// The profiles built in: `local` (the default) and `hosted`.
pub fn builtin(name: &str) -> Option<Verified> {
    let profile = match name {
        "local" => Profile {
            v: 1,
            name: "Local network".into(),
            relays: vec![],
            lookup: None,
            access: None,
            push: None,
            admin: None,
            local: Local { mdns: true },
            issued_at: 0,
        },
        "hosted" => Profile {
            v: 1,
            name: "hivemind".into(),
            relays: ["euw1", "use1", "aps1"]
                .iter()
                .map(|r| Relay {
                    url: format!("https://{r}.relay.hivemind.griiken.com"),
                })
                .collect(),
            lookup: Some("https://dns.hivemind.griiken.com/pkarr".into()),
            access: Some(AccessService {
                url: "https://access.hivemind.griiken.com".into(),
                policy: Policy::OpenPow,
            }),
            push: Some(PushService {
                url: "https://push.hivemind.griiken.com/push".into(),
                kinds: vec!["apns".into(), "fcm".into(), "unifiedpush".into()],
                vapid: None,
            }),
            admin: None,
            local: Local { mdns: true },
            issued_at: 0,
        },
        _ => return None,
    };
    let builtin = if name == "local" { "local" } else { "hosted" };
    Some(Verified {
        profile,
        builtin: Some(builtin),
        admin: None,
    })
}

fn signed_bytes(text: &str) -> Vec<u8> {
    [DOMAIN, text.as_bytes()].concat()
}

/// Sign the profile `text` with the admin key `admin`, which the profile must name.
pub fn sign(text: &str, admin: &SecretKey) -> Result<Signed> {
    let profile: Profile = serde_json::from_str(text).context("the profile is not JSON")?;
    profile.check()?;
    ensure!(
        profile.admin.as_deref() == Some(&admin.public().to_string()),
        "the profile must name the key that signs it as its admin"
    );
    Ok(Signed {
        profile: text.to_string(),
        signature: hex::encode(admin.sign(&signed_bytes(text)).to_bytes()),
    })
}

/// Verify a signed profile file: it names its admin, and the admin signed it.
pub fn verify(file: &Signed) -> Result<Verified> {
    let profile: Profile =
        serde_json::from_str(&file.profile).context("the profile is not JSON")?;
    profile.check()?;
    let admin_hex = profile
        .admin
        .as_deref()
        .context("a signed profile names its admin")?;
    let mut admin_bytes = [0u8; 32];
    hex::decode_to_slice(admin_hex, &mut admin_bytes)
        .with_context(|| format!("{admin_hex} is not a public key"))?;
    let admin = PublicKey::from_bytes(&admin_bytes)
        .with_context(|| format!("{admin_hex} is not a public key"))?;
    let mut signature = [0u8; 64];
    hex::decode_to_slice(&file.signature, &mut signature).context("the signature is not one")?;
    admin
        .verify(
            &signed_bytes(&file.profile),
            &Signature::from_bytes(&signature),
        )
        .map_err(|_| anyhow::anyhow!("the profile is not signed by its admin"))?;
    Ok(Verified {
        profile,
        builtin: None,
        admin: Some(admin),
    })
}

/// A profile from what someone gave: a built-in name, a link, or a signed file's text.
pub fn load(given: &str) -> Result<Verified> {
    match builtin(given.trim()) {
        Some(found) => Ok(found),
        None => verify(&signed(given)?),
    }
}

/// The signed file a link carries, or a signed file's text, not yet verified.
pub fn signed(given: &str) -> Result<Signed> {
    let given = given.trim();
    let text = if let Some(encoded) = given.strip_prefix(LINK_PREFIX) {
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded.trim_end_matches('/'))
            .context("the link does not carry a profile")?;
        String::from_utf8(bytes).context("the link does not carry a profile")?
    } else {
        given.to_string()
    };
    serde_json::from_str(&text).context("not a signed profile")
}

/// The link that carries `file`.
pub fn link(file: &Signed) -> String {
    let json = serde_json::to_string(file).expect("a profile file serializes");
    format!("{LINK_PREFIX}{}", URL_SAFE_NO_PAD.encode(json))
}

/// The link that carries `file` and an enrolment voucher (`access.rs`): the device that uses it
/// redeems the voucher, and is enrolled on the network's relays.
pub fn enrolment_link(file: &Signed, enrol: serde_json::Value) -> String {
    let json =
        serde_json::json!({ "profile": file.profile, "signature": file.signature, "enrol": enrol });
    format!("{LINK_PREFIX}{}", URL_SAFE_NO_PAD.encode(json.to_string()))
}

impl Verified {
    /// What is shown of it: the profile, which built-in it is, and who signed it.
    pub fn describe(&self) -> serde_json::Value {
        serde_json::json!({
            "builtin": self.builtin,
            "admin": self.admin.map(|a| a.to_string()),
            "profile": self.profile,
        })
    }
}

/// Refuse a profile for the network whose admin is `current` when another key signed it: a
/// profile change must be signed by the same admin (§13.2). A built-in profile, or another
/// network (a different name), is the person's choice to make.
pub fn same_admin(current: &Verified, next: &Verified) -> Result<()> {
    if current.builtin.is_none()
        && next.builtin.is_none()
        && current.profile.name == next.profile.name
        && current.admin != next.admin
    {
        bail!(
            "this update to {} is not signed by its admin",
            current.profile.name
        );
    }
    Ok(())
}
