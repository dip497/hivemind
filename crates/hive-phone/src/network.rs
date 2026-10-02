//! The network the phone reaches the person's devices through (spec/pairing.md 0.5): the one the
//! app it paired with is on, given as the app answered, kept in `network.json` beside its keys
//! (readable by this user alone), and used for every connection the phone makes from then on (its
//! relays and lookup server, and the local network). None: the local network alone.

use std::fs;

use anyhow::Result;
use hive_net::{
    net::Reach,
    profile::{self, Policy, Verified},
};

use crate::identity::{write_private, Identity};

const NETWORK: &str = "network.json";

/// A network as given: what `profile::load` takes, when it verifies.
pub fn verified(given: &str) -> Option<Verified> {
    profile::load(given).ok()
}

impl Identity {
    /// The network this phone is on, other than the local one.
    pub fn network(&self) -> Option<Verified> {
        let text = fs::read_to_string(self.dir().join(NETWORK)).ok()?;
        verified(&serde_json::from_str::<String>(&text).ok()?)
    }

    /// How this phone reaches the person's devices: through its network, and on the local one.
    pub fn reach(&self) -> Reach {
        self.network()
            .and_then(|n| n.profile.reach().ok())
            .unwrap_or_else(Reach::local)
    }

    /// Keep `given` as this phone's network, or none.
    pub(crate) fn keep_network(&self, given: Option<&str>) -> Result<()> {
        match given {
            Some(given) => write_private(
                &self.dir().join(NETWORK),
                &format!("{}\n", serde_json::to_string(given)?),
            ),
            None => match fs::remove_file(self.dir().join(NETWORK)) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
                _ => Ok(()),
            },
        }
    }

    /// Let this phone onto its network's relays where it does that itself: registering on an
    /// `open-pow` network. On a `closed` one the app vouched for it as it paired. What happened.
    pub async fn admit(&self) -> Result<&'static str> {
        let Some(access) = self.network().and_then(|n| n.profile.access) else {
            return Ok("none needed");
        };
        Ok(match access.policy {
            Policy::OpenPow => {
                hive_net::access::client::register(&access.url, self.key()).await?;
                "registered"
            }
            Policy::Closed => "vouched for by the app",
        })
    }
}
