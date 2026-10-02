//! The phone's connections to the person's devices (docs/design/phone-app-2026-10-02.md §3.2):
//! one to each device it reaches, kept while the app is in the foreground and used for everything
//! there (what each device says, watching, calls), and closed in the background, where iOS
//! suspends sockets. A device not reached is dialled again 250 ms later, then twice as long each
//! time up to 16 s, back to 250 ms once a connection lasted 30 s; coming to the foreground dials
//! every device at once and ends every wait. What each device said last is kept (`heard.json`),
//! to show before it says more.

use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, PoisonError,
    },
    time::{Duration, Instant},
};

use anyhow::Result;
use iroh::{endpoint::Connection, Endpoint};
use serde_json::{json, Value};
use tokio::{
    sync::{watch, Notify},
    task::JoinHandle,
};

use crate::{
    agents,
    devices::{self, PairedDevice, ANSWER_WITHIN},
    failure::{Failure, Lost},
    identity::Identity,
    needs::{self, Heard},
    now_ms,
    pairing::PairedWith,
    workspace,
};

/// A device's first wait before it is dialled again, and its longest.
const FIRST_WAIT: Duration = Duration::from_millis(250);
const LONGEST_WAIT: Duration = Duration::from_secs(16);
/// Connected this long, a device's next wait is the first again.
const STEADY: Duration = Duration::from_secs(30);
/// How long a stream the device ended waits to be opened again, the connection staying.
const AGAIN: Duration = Duration::from_secs(1);

/// The phone's connections, shared by all that use them.
#[derive(Clone)]
pub struct Connections(Arc<Shared>);

struct Shared {
    identity: Arc<Identity>,
    /// The phone on the network: made when first needed, and made again when the network it is on
    /// changes.
    endpoint: tokio::sync::Mutex<Option<Endpoint>>,
    /// Each of the person's devices the phone knows, by its id.
    links: Mutex<BTreeMap<String, Link>>,
    foreground: watch::Sender<bool>,
    /// Told whenever what is known of the person's devices changes.
    changed: Box<dyn Fn() + Send + Sync>,
    /// What each app this phone paired with last told of the person's other devices.
    told: Mutex<BTreeMap<String, Value>>,
    /// One change at a time to what the phone keeps of its devices.
    keeping: Mutex<()>,
}

/// A device's connection, while there is one, and what keeps dialling it.
struct Link {
    connection: watch::Sender<Option<Connection>>,
    /// Ends its wait.
    wake: Arc<Notify>,
    dialling: JoinHandle<()>,
}

/// What the phone knows of one of the person's devices now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Seen {
    pub with: PairedWith,
    /// Connected now.
    pub reachable: bool,
    /// When it was last found away, while it is (spec/needs.md "Asking").
    pub away_since: Option<u64>,
    /// What it said last, and when.
    pub heard: Option<Heard>,
}

impl Connections {
    /// The connections of the phone `identity`, none made before the foreground; `changed` is told
    /// whenever what is known of the person's devices changes.
    pub fn new(identity: Arc<Identity>, changed: impl Fn() + Send + Sync + 'static) -> Self {
        Self(Arc::new(Shared {
            identity,
            endpoint: tokio::sync::Mutex::new(None),
            links: Mutex::new(BTreeMap::new()),
            foreground: watch::Sender::new(false),
            changed: Box::new(changed),
            told: Mutex::new(BTreeMap::new()),
            keeping: Mutex::new(()),
        }))
    }

    /// The app came to the foreground: every device is dialled now, every wait ended. Called in
    /// the runtime the connections run on.
    pub fn foreground(&self) {
        self.0.know_devices();
        self.0.foreground.send_replace(true);
        for link in lock(&self.0.links).values() {
            link.wake.notify_one();
        }
        // The network may be another since: the endpoint looks again.
        let shared = self.0.clone();
        tokio::spawn(async move {
            let endpoint = shared.endpoint.lock().await.clone();
            if let Some(endpoint) = endpoint {
                endpoint.network_change().await;
            }
        });
    }

    /// The app went to the background: every connection is closed.
    pub fn background(&self) {
        self.0.foreground.send_replace(false);
    }

    /// The person's devices changed, the network they are reached through as it was (one was
    /// unpaired): each still the person's is dialled, and none other.
    pub fn devices_changed(&self) {
        self.0.know_devices();
        (self.0.changed)();
    }

    /// The person's devices, and the network the phone reaches them through, may have changed
    /// (it paired): each is reached anew, through the network it is on now.
    pub async fn renew(&self) {
        let old = self.0.endpoint.lock().await.take();
        for link in lock(&self.0.links).values() {
            if let Some(connection) = link.connection.borrow().as_ref() {
                connection.close(0u32.into(), b"renewed");
            }
            link.wake.notify_one();
        }
        self.0.know_devices();
        (self.0.changed)();
        if let Some(old) = old {
            old.close().await;
        }
    }

    /// The phone's endpoint, made when first needed.
    pub async fn endpoint(&self) -> Result<Endpoint> {
        self.0.endpoint().await
    }

    /// A connection to `device` for a call: the one kept, or, in the foreground, the one its
    /// dialling makes now; in the background, one of the call's own.
    pub async fn to(&self, device: &str) -> Result<Connection> {
        let link = lock(&self.0.links)
            .get(device)
            .map(|link| (link.connection.subscribe(), link.wake.clone()));
        if let Some((mut live, wake)) = link.filter(|_| *self.0.foreground.borrow()) {
            let open =
                |c: &Option<Connection>| c.as_ref().is_some_and(|c| c.close_reason().is_none());
            if let Some(connection) = live.borrow().clone().filter(|c| c.close_reason().is_none()) {
                return Ok(connection);
            }
            wake.notify_one();
            let made = tokio::time::timeout(ANSWER_WITHIN, live.wait_for(open)).await;
            if let Ok(Ok(made)) = made {
                return Ok(made.clone().expect("a connection"));
            }
            return Err(
                Failure::Unreachable(format!("{} did not answer", self.name(device))).into(),
            );
        }
        let devices = self.0.identity.devices();
        if devices.is_empty() {
            return Err(Failure::NotPaired.into());
        }
        match devices.into_iter().find(|d| d.with.device == device) {
            Some(d) => self.0.dial(&d.with).await,
            None => Err(Failure::Invalid(format!("{device} is not one of your devices")).into()),
        }
    }

    /// A connection to `device` for a call in `workspace`, which it holds: one that does not would
    /// close the connection as the workspace is opened on it.
    pub async fn holding(&self, device: &str, workspace: &str) -> Result<Connection> {
        let connection = self.to(device).await?;
        if !workspace::holds(&connection, workspace).await? {
            let name = self.name(device);
            return Err(
                Failure::Unreachable(format!("{name} does not hold that workspace now")).into(),
            );
        }
        Ok(connection)
    }

    /// The connection kept to `device`, once there is one: in the foreground, as its dialling
    /// makes it, and never one of its own, so a stream on it lives no longer than the app is in
    /// front. Lost for a device that is not one of the person's.
    pub async fn kept(&self, device: &str) -> Result<Connection, Lost> {
        let open = |c: &Option<Connection>| c.as_ref().is_some_and(|c| c.close_reason().is_none());
        loop {
            let link = lock(&self.0.links)
                .get(device)
                .map(|link| link.connection.subscribe());
            if let Some(mut live) = link {
                // The link goes once the device is forgotten.
                if let Ok(kept) = live.wait_for(open).await {
                    return Ok(kept.clone().expect("a connection"));
                }
                continue;
            }
            let devices = self.0.identity.devices();
            if devices.is_empty() {
                return Err(Lost::Unpaired(Failure::NotPaired.to_string()));
            }
            if !devices.iter().any(|d| d.with.device == device) {
                let gone = format!("{device} is not one of your devices");
                return Err(Lost::Unpaired(gone));
            }
            // None is dialled before the foreground; one just paired, a moment after.
            let mut foreground = self.0.foreground.subscribe();
            let _ = foreground.wait_for(|in_front| *in_front).await;
            tokio::time::sleep(FIRST_WAIT).await;
        }
    }

    /// The connection kept to `device`, for a stream in `workspace`, which it holds: waited for as
    /// `kept` waits for it, across the background, the foreground and the device's reconnects.
    /// Lost when the device holds the workspace no more, or is no longer one of the person's.
    pub async fn kept_for(&self, device: &str, workspace: &str) -> Result<Connection, Lost> {
        loop {
            let connection = self.kept(device).await?;
            let holds = workspace::holds(&connection, workspace);
            match tokio::time::timeout(ANSWER_WITHIN, holds).await {
                Ok(Ok(true)) => return Ok(connection),
                Ok(Ok(false)) => {
                    let name = self.name(device);
                    return Err(Lost::NotHeld(format!(
                        "{name} does not hold that workspace now"
                    )));
                }
                // Not answered: asked again, on the next connection when this one went.
                _ => Self::again(&connection).await,
            }
        }
    }

    /// A stream on `connection` ended, not of its own: it is opened again on the connection kept
    /// next, after a moment when the device ended it and the connection stays.
    pub async fn again(connection: &Connection) {
        if connection.close_reason().is_none() {
            tokio::time::sleep(AGAIN).await;
        }
    }

    /// What the phone knows of each of the person's devices now, as they are listed.
    pub fn seen(&self) -> Vec<Seen> {
        let identity = &self.0.identity;
        let (heard, away) = (identity.heard(), identity.away());
        let links = lock(&self.0.links);
        identity
            .devices()
            .into_iter()
            .map(|d| {
                let id = &d.with.device;
                Seen {
                    reachable: links
                        .get(id)
                        .is_some_and(|link| link.connection.borrow().is_some()),
                    away_since: away.get(id).copied(),
                    heard: heard.get(id).cloned(),
                    with: d.with,
                }
            })
            .collect()
    }

    /// What `device` is called, or its id when the phone knows it no more.
    fn name(&self, device: &str) -> String {
        let devices = self.0.identity.devices();
        let named = devices.iter().find(|d| d.with.device == device);
        named.map_or_else(|| device.to_string(), |d| d.with.name.clone())
    }
}

impl Shared {
    async fn endpoint(&self) -> Result<Endpoint> {
        let mut endpoint = self.endpoint.lock().await;
        if let Some(endpoint) = endpoint.as_ref() {
            return Ok(endpoint.clone());
        }
        let key = self.identity.key().clone();
        let made = hive_net::net::endpoint(key, &self.identity.reach(), vec![]).await?;
        *endpoint = Some(made.clone());
        Ok(made)
    }

    /// Dial `with`, as long as a device has to answer.
    async fn dial(&self, with: &PairedWith) -> Result<Connection> {
        let endpoint = self.endpoint().await?;
        let at = hive_net::net::addr_of(&with.device, &with.addrs, &with.relay)?;
        match tokio::time::timeout(ANSWER_WITHIN, endpoint.connect(at, hive_net::ws::ALPN)).await {
            Ok(Ok(connection)) => Ok(connection),
            Ok(Err(e)) => {
                Err(Failure::Unreachable(format!("{} is not reached: {e}", with.name)).into())
            }
            Err(_) => Err(Failure::Unreachable(format!("{} did not answer", with.name)).into()),
        }
    }

    /// Change what the phone keeps of its devices, one change at a time.
    fn keep<T>(&self, change: impl FnOnce(&Identity) -> T) -> T {
        let _one = lock(&self.keeping);
        change(&self.identity)
    }

    /// Each of the person's devices the phone knows is dialled, and none it knows no more.
    fn know_devices(self: &Arc<Self>) {
        let devices = self.identity.devices();
        let mut links = lock(&self.links);
        links.retain(|id, link| {
            let known = devices.iter().any(|d| d.with.device == *id);
            if !known {
                link.dialling.abort();
                if let Some(connection) = link.connection.borrow().as_ref() {
                    connection.close(0u32.into(), b"forgotten");
                }
            }
            known
        });
        for device in devices {
            links.entry(device.with.device.clone()).or_insert_with(|| {
                let connection = watch::Sender::new(None);
                let wake = Arc::new(Notify::new());
                let dialling = tokio::spawn(keep_dialling(
                    self.clone(),
                    device.with.device,
                    connection.clone(),
                    wake.clone(),
                ));
                Link {
                    connection,
                    wake,
                    dialling,
                }
            });
        }
    }
}

/// Keep `device` connected while the app is in the foreground: dial it, and once it is reached
/// hear what it says, until the connection goes or the app goes to the background; dial again
/// after a wait, or at once when woken.
async fn keep_dialling(
    shared: Arc<Shared>,
    device: String,
    connection: watch::Sender<Option<Connection>>,
    wake: Arc<Notify>,
) {
    let mut foreground = shared.foreground.subscribe();
    let mut wait = FIRST_WAIT;
    loop {
        if foreground.wait_for(|in_front| *in_front).await.is_err() {
            return;
        }
        let devices = shared.identity.devices();
        let Some(paired) = devices.into_iter().find(|d| d.with.device == device) else {
            return;
        };
        match shared.dial(&paired.with).await {
            Ok(live) => {
                let began = Instant::now();
                connection.send_replace(Some(live.clone()));
                (shared.changed)();
                let hearing = tokio::spawn(hear(shared.clone(), paired, live.clone()));
                tokio::select! {
                    _ = live.closed() => {}
                    _ = foreground.wait_for(|in_front| !*in_front) => {
                        live.close(0u32.into(), b"background");
                    }
                }
                hearing.abort();
                connection.send_replace(None);
                (shared.changed)();
                if began.elapsed() >= STEADY {
                    wait = FIRST_WAIT;
                }
            }
            Err(_) => {
                let away = std::slice::from_ref(&device);
                let _ = shared.keep(|identity| identity.mark_away(away, now_ms()));
                (shared.changed)();
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(wait) => wait = (wait * 2).min(LONGEST_WAIT),
            _ = wake.notified() => wait = FIRST_WAIT,
        }
    }
}

/// Hear what `paired` says while it is reached on `connection`: an app this phone paired with,
/// which of the person's computers and hosts it tells of, and whose they are (spec/pairing.md 0.7,
/// 0.8); every device, the workspaces it holds, and every agent there as they change, on its
/// `agents` stream (spec/agents.md "Following"). A device that sends no list of them in the time it
/// has to answer is asked what waits on the person there instead (spec/needs.md); one that does not
/// answer that either is away.
async fn hear(shared: Arc<Shared>, paired: PairedDevice, connection: Connection) {
    let with = paired.with;
    if with.kind == "app" && paired.via.is_empty() {
        let question = json!({ "t": "devices" });
        let asked = devices::ask(&connection, &question);
        if let Ok(Ok(answer)) = tokio::time::timeout(ANSWER_WITHIN, asked).await {
            let told: Vec<(String, Value)> = {
                let mut told = lock(&shared.told);
                told.insert(with.device.clone(), answer);
                told.iter()
                    .map(|(by, answer)| (by.clone(), answer.clone()))
                    .collect()
            };
            let _ = shared.keep(|identity| identity.learn_all(&told, now_ms()));
            shared.know_devices();
            (shared.changed)();
        }
    }
    if let Ok(Ok(held)) = tokio::time::timeout(ANSWER_WITHIN, workspace::held(&connection)).await {
        let _ = shared.keep(|identity| identity.hear_workspaces(&with.device, &held, now_ms()));
        (shared.changed)();
    }
    let listed = AtomicBool::new(false);
    let following = agents::follow(&connection, &with.device, |list| {
        listed.store(true, Ordering::Relaxed);
        let _ = shared.keep(|identity| identity.hear_agents(&with.device, &list, now_ms()));
        (shared.changed)();
    });
    let unanswered = tokio::time::sleep(ANSWER_WITHIN);
    tokio::pin!(following, unanswered);
    let stopped = tokio::select! {
        _ = &mut following => true,
        () = &mut unanswered => false,
    };
    // Gone with the connection, the device is not away: the phone may have closed it.
    if connection.close_reason().is_some() {
        return;
    }
    if !listed.load(Ordering::Relaxed) {
        let asked = needs::ask_on(&connection, &with.name);
        match tokio::time::timeout(ANSWER_WITHIN, asked).await {
            Ok(Ok(answer)) => {
                let answers = [(with.device.clone(), answer)];
                let _ = shared.keep(|identity| identity.hear(&answers, now_ms()));
            }
            _ => {
                let away = std::slice::from_ref(&with.device);
                let _ = shared.keep(|identity| identity.mark_away(away, now_ms()));
                connection.close(0u32.into(), b"no answer");
            }
        }
        (shared.changed)();
    }
    if !stopped {
        let _ = following.await;
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
