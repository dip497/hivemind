//! What the tests of the phone's live connections share: a computer of the person's, reached over
//! iroh on this machine, which answers the phone as the app does: on its `device` stream; on its
//! `agents` stream, when it lists them; and on its `api` stream, where it shows one terminal, keeps
//! what the phone types into it, and tells what its agent and the person say to each other.

#![allow(dead_code)]

use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use hive_net::{
    frames::{read_frame, write_frame},
    net::Reach,
};
use hive_phone::{
    identity::{DeviceCertificate, Identity},
    pairing::{Paired, PairedWith},
};
use iroh::{
    endpoint::{Connection, RecvStream, SendStream},
    Endpoint, SecretKey,
};
use serde_json::{json, Value};
use tokio::sync::watch;

/// The workspace the computer holds, and the tile whose terminal it shows.
pub const WORKSPACE: &str = "w1";
pub const TILE: &str = "t1";
/// The agent's session, as the computer names it.
pub const SESSION: &str = "s1";

pub fn key(n: u8) -> SecretKey {
    SecretKey::from_bytes(&[n; 32])
}

/// A folder of the test `name`'s own, empty.
pub fn tmp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("hive-phone-live-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

/// "Device `device` is `person`'s", signed by the person key: what an app gives.
fn certify(person: &SecretKey, device: &str) -> DeviceCertificate {
    let issued_at = 1_790_000_000_000u64;
    let mut bytes = b"hive/device-certificate/1\n".to_vec();
    bytes.extend(person.public().as_bytes());
    bytes.extend(hex::decode(device).unwrap());
    bytes.extend(issued_at.to_be_bytes());
    DeviceCertificate {
        v: 1,
        person: person.public().to_string(),
        device: device.to_string(),
        issued_at,
        signature: hex::encode(person.sign(&bytes).to_bytes()),
    }
}

/// A phone, its keys in `dir`, paired with `desk`, Priya's computer.
pub fn paired_with(dir: &Path, desk: &Desk) -> Arc<Identity> {
    let priya = key(9);
    let phone = Identity::open(dir).unwrap();
    let with = PairedWith {
        device: desk.id.clone(),
        name: "desk".into(),
        kind: "app".into(),
        certificate: certify(&priya, &desk.id),
        addrs: vec![format!("127.0.0.1:{}", desk.port)],
        relay: None,
    };
    let paired = Paired {
        with,
        certificate: certify(&priya, &phone.id()),
        network: None,
    };
    phone.keep(&paired, 1).unwrap();
    Arc::new(phone)
}

/// Priya's computer, as the phone reaches it.
pub struct Desk {
    pub id: String,
    pub port: u16,
    endpoint: Endpoint,
    /// What the phone told its `api` stream, and when, as it came.
    pub told: Arc<Mutex<Vec<(Instant, Value)>>>,
    /// How many connections the phone made to it, and how many of them closed.
    pub dialled: Arc<AtomicUsize>,
    pub closed: Arc<AtomicUsize>,
    /// How many times it told the phone what waits on the person.
    pub answered: Arc<AtomicUsize>,
    /// How many `api` streams the phone let go of.
    pub left: Arc<AtomicUsize>,
    /// Its list of agents, `{t:"agents", …}`, sent to each that follows them and again as it
    /// changes; none: it does not list its agents, and closes the stream.
    pub agents: watch::Sender<Option<Value>>,
    /// What its terminal shows, sent whole to each that opens it; and whether its session ended
    /// before then, so it attaches to none.
    pub screen: Arc<Mutex<String>>,
    pub ended: Arc<AtomicBool>,
    /// How many times the phone opened its terminal.
    pub opened: Arc<AtomicUsize>,
    /// What the agent of its tile and the person said, as its session file holds it: each entry
    /// with how far into the file it goes.
    pub said: watch::Sender<Vec<(u64, Value)>>,
    /// How far into the conversation the phone asked from each time, as it asked.
    pub asked_from: Arc<Mutex<Vec<Option<u64>>>>,
    /// The connections the phone made, while they last.
    connections: Arc<Mutex<Vec<Connection>>>,
}

/// What the computer's streams share.
#[derive(Clone)]
struct Serving {
    told: Arc<Mutex<Vec<(Instant, Value)>>>,
    answered: Arc<AtomicUsize>,
    left: Arc<AtomicUsize>,
    agents: watch::Sender<Option<Value>>,
    screen: Arc<Mutex<String>>,
    ended: Arc<AtomicBool>,
    opened: Arc<AtomicUsize>,
    said: watch::Sender<Vec<(u64, Value)>>,
    asked_from: Arc<Mutex<Vec<Option<u64>>>>,
}

impl Desk {
    /// The computer `n`, answering on this machine: one agent of its waits on the person, one is
    /// at work; its terminal is 100 by 30, held by Sam, until the phone is given its keyboard. It
    /// does not list its agents.
    pub async fn start(n: u8) -> Self {
        let reach = Reach {
            relays: vec![],
            lookup: None,
            mdns: false,
        };
        let alpns = vec![hive_net::ws::ALPN.to_vec()];
        let endpoint = hive_net::net::endpoint(key(n), &reach, alpns)
            .await
            .unwrap();
        let port = endpoint
            .bound_sockets()
            .iter()
            .find(|a| a.is_ipv4())
            .unwrap()
            .port();
        let desk = Self {
            id: key(n).public().to_string(),
            port,
            endpoint: endpoint.clone(),
            told: Arc::default(),
            dialled: Arc::default(),
            closed: Arc::default(),
            answered: Arc::default(),
            left: Arc::default(),
            agents: watch::Sender::new(None),
            screen: Arc::new(Mutex::new("Hello from the agent".into())),
            ended: Arc::default(),
            opened: Arc::default(),
            said: watch::Sender::new(vec![]),
            asked_from: Arc::default(),
            connections: Arc::default(),
        };
        let serving = Serving {
            told: desk.told.clone(),
            answered: desk.answered.clone(),
            left: desk.left.clone(),
            agents: desk.agents.clone(),
            screen: desk.screen.clone(),
            ended: desk.ended.clone(),
            opened: desk.opened.clone(),
            said: desk.said.clone(),
            asked_from: desk.asked_from.clone(),
        };
        let (dialled, closed) = (desk.dialled.clone(), desk.closed.clone());
        let connections = desk.connections.clone();
        tokio::spawn(async move {
            while let Some(incoming) = endpoint.accept().await {
                let Ok(connection) = incoming.await else {
                    continue;
                };
                dialled.fetch_add(1, Ordering::SeqCst);
                connections.lock().unwrap().push(connection.clone());
                let (closed, serving) = (closed.clone(), serving.clone());
                tokio::spawn(async move {
                    serve(&connection, serving).await;
                    connection.closed().await;
                    closed.fetch_add(1, Ordering::SeqCst);
                });
            }
        });
        desk
    }

    /// The computer is gone: off, or off the network.
    pub async fn stop(&self) {
        self.endpoint.close().await;
    }

    /// Every connection the phone made drops, as when the network goes for a moment.
    pub fn drop_connections(&self) {
        for connection in self.connections.lock().unwrap().drain(..) {
            connection.close(0u32.into(), b"dropped");
        }
    }

    /// The agent says `entry`, which goes as far as `cursor` into its session file.
    pub fn say(&self, cursor: u64, entry: Value) {
        self.said.send_modify(|said| said.push((cursor, entry)));
    }

    /// The `api` notices the phone sent, by method and params, without when.
    pub fn notices(&self) -> Vec<Value> {
        let told = self.told.lock().unwrap();
        told.iter().map(|(_, notice)| notice.clone()).collect()
    }
}

/// Answer each stream the phone opens on `connection`, until it closes.
async fn serve(connection: &Connection, serving: Serving) {
    let phone = format!("peer:{}", connection.remote_id());
    while let Ok((send, mut recv)) = connection.accept_bi().await {
        let (phone, serving) = (phone.clone(), serving.clone());
        tokio::spawn(async move {
            match read_frame(&mut recv).await.ok().flatten().as_deref() {
                Some(b"device") => device(send, recv, &serving).await,
                Some(b"agents") => agents(send, recv, &serving).await,
                Some(b"api") => {
                    api(send, recv, &phone, &serving).await;
                    serving.left.fetch_add(1, Ordering::SeqCst);
                }
                _ => {}
            }
        });
    }
}

/// The `device` stream, as the app answers it.
async fn device(mut send: SendStream, mut recv: RecvStream, serving: &Serving) {
    while let Ok(Some(frame)) = read_frame(&mut recv).await {
        let asked: Value = serde_json::from_slice(&frame).unwrap();
        let answer = match asked["t"].as_str() {
            Some("needs") => json!({ "t": "needs", "working": 1, "needs": [{
                "workspace": WORKSPACE, "name": "api", "tile": TILE, "agent": "Editing Nav.tsx",
                "kind": "permission", "since": 1_790_000_000_000u64, "decide": true,
            }] }),
            Some("workspaces") => json!({ "t": "workspaces", "workspaces": [
                { "workspace": WORKSPACE, "name": "api", "repo": "/home/priya/api" },
            ] }),
            Some("devices") => json!({ "t": "devices", "devices": [],
                "profile": { "name": "Priya", "color": "#aa3366" } }),
            Some("unpair") => json!({ "t": "unpair", "ok": true }),
            _ => continue,
        };
        let _ = write_frame(&mut send, answer.to_string().as_bytes()).await;
        if asked["t"] == "needs" {
            serving.answered.fetch_add(1, Ordering::SeqCst);
        }
    }
}

/// The `agents` stream, followed: the list now, and again each time it changes, until the phone
/// lets go; closed at once by a computer that does not list its agents.
async fn agents(mut send: SendStream, mut recv: RecvStream, serving: &Serving) {
    let mut listed = serving.agents.subscribe();
    if listed.borrow().is_none() {
        return;
    }
    let Ok(Some(_follow)) = read_frame(&mut recv).await else {
        return;
    };
    loop {
        let list = listed.borrow_and_update().clone();
        if let Some(list) = list {
            if write_frame(&mut send, list.to_string().as_bytes())
                .await
                .is_err()
            {
                return;
            }
        }
        tokio::select! {
            changed = listed.changed() => if changed.is_err() { return },
            // The phone sends nothing more: its end of the stream closes as it lets go.
            _ = read_frame(&mut recv) => return,
        }
    }
}

/// The `api` stream of the workspace: its terminal's keyboard, size and screen as the phone opens
/// it, or none when its session ended; its keyboard given to the phone, `phone`, as it asks; what
/// the phone types kept; and the session's end once it types Ctrl-C. Or its agent's conversation.
async fn api(mut send: SendStream, mut recv: RecvStream, phone: &str, serving: &Serving) {
    let session = format!("hm:{TILE}");
    let Ok(Some(_open)) = read_frame(&mut recv).await else {
        return;
    };
    while let Ok(Some(frame)) = read_frame(&mut recv).await {
        let message: Value = serde_json::from_slice(&frame).unwrap();
        if message["method"] == "agent.conversation" {
            return converse(send, recv, &message, serving).await;
        }
        let mut out = vec![];
        if let Some(id) = message.get("id") {
            let mut pid = 1;
            if message["method"] == "terminal.open" {
                serving.opened.fetch_add(1, Ordering::SeqCst);
                if serving.ended.load(Ordering::SeqCst) {
                    pid = -1;
                } else {
                    let sam = json!({ "id": "peer:sam", "person": "s", "name": "Sam" });
                    let screen = serving.screen.lock().unwrap().clone();
                    out.push(json!([
                        { "event": "terminal.keyboard", "params": [session, sam] },
                        { "event": "terminal.size", "params": [session, 100, 30] },
                        { "event": "terminal.data", "params": [session, screen] },
                    ]));
                }
            }
            out.push(json!({ "id": id, "result": { "pid": pid, "joined": pid > 0 } }));
        } else {
            serving
                .told
                .lock()
                .unwrap()
                .push((Instant::now(), message.clone()));
            if message["method"] == "terminal.keyboard.ask" {
                let holder = json!({ "id": phone, "person": "p", "name": "Priya's phone" });
                out.push(json!({ "event": "terminal.keyboard", "params": [session, holder] }));
            }
            if message["params"][1] == "\x03" {
                out.push(json!({ "event": "terminal.exit", "params": [session, { "code": 3 }] }));
            }
        }
        for frame in out {
            if write_frame(&mut send, frame.to_string().as_bytes())
                .await
                .is_err()
            {
                return;
            }
        }
    }
}

/// `agent.conversation`, `asked`: of its tile, what was said after the cursor given (all of it
/// without one), then each entry as it is said, until the phone lets go; of any other tile,
/// refused.
async fn converse(mut send: SendStream, mut recv: RecvStream, asked: &Value, serving: &Serving) {
    let id = &asked["id"];
    if asked["params"][0] != TILE {
        let refused = json!({ "id": id,
            "error": { "code": "not_found", "message": "no agent runs there" } });
        let _ = write_frame(&mut send, refused.to_string().as_bytes()).await;
        let _ = read_frame(&mut recv).await;
        return;
    }
    let from = asked["params"][1].as_u64();
    serving.asked_from.lock().unwrap().push(from);
    let mut said = serving.said.subscribe();
    // What was said after `from`, and how far into the file it goes.
    let after = |said: &[(u64, Value)], from: Option<u64>| {
        let after: Vec<&(u64, Value)> = said
            .iter()
            .filter(|(at, _)| from.is_none_or(|from| *at > from))
            .collect();
        let at = after.last().map_or(from.unwrap_or(0), |(at, _)| *at);
        let entries: Vec<Value> = after.into_iter().map(|(_, e)| e.clone()).collect();
        (entries, at)
    };
    let (entries, mut at) = after(&said.borrow_and_update(), from);
    let answer = json!({ "id": id,
        "result": { "entries": entries, "cursor": at, "session": SESSION } });
    if write_frame(&mut send, answer.to_string().as_bytes())
        .await
        .is_err()
    {
        return;
    }
    loop {
        tokio::select! {
            changed = said.changed() => if changed.is_err() { return },
            // The phone sends nothing more: its end of the stream closes as it lets go.
            _ = read_frame(&mut recv) => return,
        }
        let (entries, now) = after(&said.borrow_and_update(), Some(at));
        if entries.is_empty() {
            continue;
        }
        at = now;
        let event = json!([{ "event": "agent.said", "params": [TILE, entries, at, SESSION] }]);
        if write_frame(&mut send, event.to_string().as_bytes())
            .await
            .is_err()
        {
            return;
        }
    }
}

/// Wait until `done`, checking every 20 ms, for `within` at most: whether it came.
pub async fn until(within: Duration, mut done: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if done() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    done()
}
