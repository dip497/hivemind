//! Connecting with an app's offer (spec/pairing.md 0.10), as the apps drive it: the phone asks with
//! the scanned link, shows the words both screens show, waits on the person at the computer, and,
//! told it is theirs, takes what the computer gives only on its own person's yes.

use std::sync::Arc;

use hive_phone::{connect, connections::Connections, identity::Identity};
use tokio::sync::Mutex;

use crate::{
    on_runtime,
    pairing::PairsWith,
    records::{DeviceKind, Paired, Person},
    PhoneError,
};

/// The computer a link to connect names, before asking: its id and its name. None when `link`, a
/// scanned QR code's text, is no offer to connect.
#[uniffi::export]
pub fn connects_with(link: String) -> Option<PairsWith> {
    connect::parse_link(&link).map(|link| PairsWith {
        device: link.device,
        name: link.name,
        kind: DeviceKind::Computer,
    })
}

/// An offer the phone asked with, until it takes what the computer gives or refuses it.
#[derive(uniffi::Object)]
pub struct Connecting {
    identity: Arc<Identity>,
    connections: Connections,
    offering: String,
    words: Vec<String>,
    asking: Arc<Mutex<Option<connect::Connecting>>>,
}

impl Connecting {
    pub(crate) fn new(
        identity: Arc<Identity>,
        connections: Connections,
        asking: connect::Connecting,
    ) -> Self {
        Self {
            identity,
            connections,
            offering: asking.asked.with.name.clone(),
            words: asking.asked.words.clone(),
            asking: Arc::new(Mutex::new(Some(asking))),
        }
    }

    /// The asking, once: it was taken or refused already, or is.
    async fn once(
        asking: &Mutex<Option<connect::Connecting>>,
    ) -> Result<connect::Connecting, PhoneError> {
        asking.lock().await.take().ok_or_else(|| {
            PhoneError::Invalid("this phone has answered that computer already".into())
        })
    }
}

#[uniffi::export]
impl Connecting {
    /// The computer asked, by its name.
    pub fn offering(&self) -> String {
        self.offering.clone()
    }

    /// The words both screens show: the person checks the computer shows the same.
    pub fn words(&self) -> Vec<String> {
        self.words.clone()
    }

    /// Wait on the person at the computer: whose this phone is, once they say it is theirs (none
    /// when their profile says nothing that can be shown). A no is refused.
    pub async fn wait(&self) -> Result<Option<Person>, PhoneError> {
        let asking = self.asking.clone();
        on_runtime(async move {
            let held = asking.lock().await;
            let asking = held.as_ref().ok_or_else(|| {
                PhoneError::Invalid("this phone has answered that computer already".into())
            })?;
            Ok(asking.wait().await?.map(Person::from))
        })
        .await
    }

    /// The person here says the words match: the phone is that person's from then on, and reaches
    /// their devices anew.
    pub async fn take(&self) -> Result<Paired, PhoneError> {
        let (asking, identity, connections) = (
            self.asking.clone(),
            self.identity.clone(),
            self.connections.clone(),
        );
        on_runtime(async move {
            let paired = Self::once(&asking).await?.take(&identity).await?;
            connections.renew().await;
            Ok(Paired {
                device: paired.with.device,
                name: paired.with.name,
                person: identity.person().map(Person::from),
            })
        })
        .await
    }

    /// The person here says the words do not match: the computer is told, and nothing is kept.
    pub async fn refuse(&self) -> Result<(), PhoneError> {
        let asking = self.asking.clone();
        on_runtime(async move {
            Self::once(&asking).await?.refuse().await;
            Ok(())
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    /// The text of conformance/pairing.json's connect link case `about`.
    fn link(about: &str) -> String {
        let cases: Value =
            serde_json::from_str(include_str!("../../../conformance/pairing.json")).unwrap();
        let case = cases["connect"]["link"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["about"] == about)
            .unwrap();
        case["text"].as_str().unwrap().to_string()
    }

    #[test]
    fn a_link_to_connect_names_the_computer_before_asking_and_anything_else_names_none() {
        let named = PairsWith {
            device: "c7b697b92fc63a2dd660f6f02f2ce32eb4a842839cbe4213845e3b4390f446c3".into(),
            name: "Priya's desktop".into(),
            kind: DeviceKind::Computer,
        };
        assert_eq!(connects_with(link("an app's offer")), Some(named.clone()));
        assert_eq!(
            connects_with(link("inside the phone page's address")),
            Some(named)
        );
        assert_eq!(connects_with(link("a pairing link")), None);
        assert_eq!(connects_with(link("five words")), None);
    }
}
