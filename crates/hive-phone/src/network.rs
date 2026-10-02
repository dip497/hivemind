//! The network the phone reaches the person's devices through (spec/pairing.md 0.5): the one the
//! app it paired with is on, given as the app answered, kept in `network.json` beside its keys
//! (readable by this user alone), and used for every connection the phone makes from then on (its
//! relays and lookup server, and the local network). None: the local network alone.

use std::fs;

use anyhow::Result;
use hive_net::{
    net::Reach,
    profile::{self, Verified},
};

use crate::{
    identity::{write_private, Identity},
    pairing::Admission,
};

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

    /// How it reaches a device that says it is reached through `relay` too.
    pub fn reach_through(&self, relay: Option<&str>) -> Reach {
        let mut reach = self.reach();
        if let Some(relay) = relay.and_then(|r| r.parse().ok()) {
            if !reach.relays.contains(&relay) {
                reach.relays.push(relay);
            }
        }
        reach
    }

    /// Get onto the network of a device whose link carries `admission`, to reach it from
    /// anywhere: with the voucher it carries, on a closed network, after which that device vouches
    /// for this phone as they pair; or registering, on an open one. How.
    pub async fn let_in(&self, admission: &Admission) -> Result<&'static str> {
        Ok(match &admission.voucher {
            Some(voucher) => {
                let voucher = serde_json::from_value(voucher.clone())
                    .map_err(|_| anyhow::anyhow!("the link's voucher is not one"))?;
                hive_net::access::client::redeem(&admission.access, &voucher, self.key()).await?;
                "vouched for by the app"
            }
            None => {
                hive_net::access::client::register(&admission.access, self.key()).await?;
                "registered"
            }
        })
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
}
