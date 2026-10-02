//! The phone, as the apps call it (docs/design/phone-app-2026-10-02.md §5.1): its identity, its
//! connections to the person's devices, the overview they make, and the calls that go out on them.

use std::{
    path::Path,
    sync::{mpsc::Sender, Arc, OnceLock},
};

use hive_phone::{
    connections::Connections,
    identity::Identity,
    pairing::{self, Pairing},
    workspace,
};

use crate::{
    on_runtime,
    overview::{Following, OverviewListener, Overviews},
    records::{AgentRef, Answer, Overview, Paired, Person},
    watch::{ScreenListener, Watch},
    PhoneError, RUNTIME,
};

#[derive(uniffi::Object)]
pub struct Phone {
    identity: Arc<Identity>,
    /// What the phone is called, as an app lists it.
    name: String,
    pub(crate) connections: Connections,
    overviews: Overviews,
}

#[uniffi::export]
impl Phone {
    /// The phone whose keys and what it knows are in `dir`, the app's private files (its device
    /// key is made the first time), called `name` ("Priya's iPhone"). Nothing is dialled before
    /// the app says it is in the foreground.
    #[uniffi::constructor]
    pub fn open(dir: String, name: String) -> Result<Arc<Self>, PhoneError> {
        let identity = Arc::new(Identity::open(Path::new(&dir))?);
        let changes: Arc<OnceLock<Sender<()>>> = Arc::default();
        let told = changes.clone();
        let connections = Connections::new(identity.clone(), move || {
            if let Some(changes) = told.get() {
                let _ = changes.send(());
            }
        });
        let overviews = Overviews::start(connections.clone(), identity.clone());
        let _ = changes.set(overviews.changes());
        Ok(Arc::new(Self {
            identity,
            name,
            connections,
            overviews,
        }))
    }

    /// The phone's id: its device key's public half, in hex.
    pub fn id(&self) -> String {
        self.identity.id()
    }

    /// Whose devices these are, as their app said: none before one did.
    pub fn person(&self) -> Option<Person> {
        self.identity.person().map(Person::from)
    }

    /// Pair with the app whose link, the QR code's text, was scanned: the phone is that app's
    /// person's from then on, and reaches their devices anew.
    pub async fn pair(&self, link: String) -> Result<Paired, PhoneError> {
        let (identity, name) = (self.identity.clone(), self.name.clone());
        let connections = self.connections.clone();
        on_runtime(async move {
            let link = pairing::parse_link(&link).ok_or_else(|| {
                PhoneError::Invalid(
                    "that is not a pairing link: it is the one under Settings → Devices on your computer"
                        .into(),
                )
            })?;
            let Pairing { paired, .. } = identity.pair_with(&name, &link).await?;
            connections.renew().await;
            Ok(Paired {
                device: paired.with.device,
                name: paired.with.name,
                person: identity.person().map(Person::from),
            })
        })
        .await
    }

    /// Unpair from `device`, by its id: whether it was told; one that was not still lists the
    /// phone, and is to be unpaired there too.
    pub async fn unpair(&self, device: String) -> Result<bool, PhoneError> {
        let (identity, connections) = (self.identity.clone(), self.connections.clone());
        on_runtime(async move {
            let endpoint = connections.endpoint().await?;
            let unpaired = identity.unpair_from(&endpoint, &device).await?;
            connections.devices_changed();
            Ok(unpaired.told)
        })
        .await
    }

    /// The app came to the foreground: every device is dialled now (§3.2).
    pub fn on_foreground(&self) {
        let _runtime = RUNTIME.enter();
        self.connections.foreground();
    }

    /// The app went to the background: the connections close.
    pub fn on_background(&self) {
        self.connections.background();
    }

    /// `listener` is told each new overview's revision, until it stops.
    pub fn follow(&self, listener: Arc<dyn OverviewListener>) -> Arc<Following> {
        Arc::new(self.overviews.follow(listener))
    }

    /// The newest overview: what each device last said, until it says more (§3.1).
    pub fn overview(&self) -> Overview {
        Overview::clone(&self.overviews.newest())
    }

    /// Answer what `agent` waits on the person for, the wait that began at `since`: whether it
    /// landed; not when it waits on that no more, or was answered.
    pub async fn answer(
        &self,
        agent: AgentRef,
        since: u64,
        answer: Answer,
    ) -> Result<bool, PhoneError> {
        let connections = self.connections.clone();
        on_runtime(async move {
            let connection = connections.holding(&agent.device, &agent.workspace).await?;
            let reply = answer.into();
            Ok(
                workspace::answer(&connection, &agent.workspace, &agent.tile, since, &reply)
                    .await?,
            )
        })
        .await
    }

    /// Send `agent` a message, one line, typed in as its next prompt: whether it went; not when no
    /// agent runs there.
    pub async fn send(&self, agent: AgentRef, text: String) -> Result<bool, PhoneError> {
        let connections = self.connections.clone();
        on_runtime(async move {
            let connection = connections.holding(&agent.device, &agent.workspace).await?;
            Ok(workspace::send(&connection, &agent.workspace, &agent.tile, &text).await?)
        })
        .await
    }

    /// Watch `agent`'s terminal: `listener` is told of each frame, its keyboard and its end. It is
    /// watched across the background, the foreground and the device's reconnects, until the
    /// session ends or the watch is stopped.
    pub fn watch(&self, agent: AgentRef, listener: Arc<dyn ScreenListener>) -> Arc<Watch> {
        let _runtime = RUNTIME.enter();
        Arc::new(Watch::start(
            &self.connections,
            &self.identity.id(),
            &agent,
            listener,
        ))
    }
}
