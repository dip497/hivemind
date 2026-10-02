//! What the tests of the phone's live connections share: a computer of the person's, reached over
//! iroh on this machine, which answers the phone as the app does on its `device` stream, and on
//! its `api` stream shows one terminal and keeps what the phone types into it.

#![allow(dead_code)]

use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
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

/// The workspace the computer holds, and the tile whose terminal it shows.
pub const WORKSPACE: &str = "w1";
pub const TILE: &str = "t1";

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
}

impl Desk {
    /// The computer `n`, answering on this machine: one agent of its waits on the person, one is
    /// at work; its terminal is 100 by 30, held by Sam, until the phone is given its keyboard.
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
        };
        let (told, dialled, closed) =
            (desk.told.clone(), desk.dialled.clone(), desk.closed.clone());
        let counts = Counts {
            answered: desk.answered.clone(),
            left: desk.left.clone(),
        };
        tokio::spawn(async move {
            while let Some(incoming) = endpoint.accept().await {
                let Ok(connection) = incoming.await else {
                    continue;
                };
                dialled.fetch_add(1, Ordering::SeqCst);
                let (told, closed, counts) = (told.clone(), closed.clone(), counts.clone());
                tokio::spawn(async move {
                    serve(&connection, told, counts).await;
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

    /// The `api` notices the phone sent, by method and params, without when.
    pub fn notices(&self) -> Vec<Value> {
        let told = self.told.lock().unwrap();
        told.iter().map(|(_, notice)| notice.clone()).collect()
    }
}

/// What the computer counts of what the phone does.
#[derive(Clone)]
struct Counts {
    answered: Arc<AtomicUsize>,
    left: Arc<AtomicUsize>,
}

/// Answer each stream the phone opens on `connection`, until it closes.
async fn serve(connection: &Connection, told: Arc<Mutex<Vec<(Instant, Value)>>>, counts: Counts) {
    let phone = format!("peer:{}", connection.remote_id());
    while let Ok((send, mut recv)) = connection.accept_bi().await {
        let (told, phone, counts) = (told.clone(), phone.clone(), counts.clone());
        tokio::spawn(async move {
            match read_frame(&mut recv).await.ok().flatten().as_deref() {
                Some(b"device") => device(send, recv, counts.answered).await,
                Some(b"api") => {
                    api(send, recv, &phone, told).await;
                    counts.left.fetch_add(1, Ordering::SeqCst);
                }
                _ => {}
            }
        });
    }
}

/// The `device` stream, as the app answers it.
async fn device(mut send: SendStream, mut recv: RecvStream, answered: Arc<AtomicUsize>) {
    while let Ok(Some(frame)) = read_frame(&mut recv).await {
        let asked: Value = serde_json::from_slice(&frame).unwrap();
        let answer = match asked["t"].as_str() {
            Some("needs") => json!({ "t": "needs", "working": 1, "needs": [{
                "workspace": WORKSPACE, "name": "api", "tile": TILE, "agent": "Editing Nav.tsx",
                "kind": "permission", "since": 1_790_000_000_000u64, "decide": true,
            }] }),
            Some("workspaces") => {
                json!({ "t": "workspaces", "workspaces": [{ "workspace": WORKSPACE }] })
            }
            Some("devices") => json!({ "t": "devices", "devices": [],
                "profile": { "name": "Priya", "color": "#aa3366" } }),
            Some("unpair") => json!({ "t": "unpair", "ok": true }),
            _ => continue,
        };
        let _ = write_frame(&mut send, answer.to_string().as_bytes()).await;
        if asked["t"] == "needs" {
            answered.fetch_add(1, Ordering::SeqCst);
        }
    }
}

/// The `api` stream of the workspace: its terminal's keyboard, size and screen as the phone opens
/// it; its keyboard given to the phone, `phone`, as it asks; what the phone types kept; and the
/// session's end once it types Ctrl-C.
async fn api(
    mut send: SendStream,
    mut recv: RecvStream,
    phone: &str,
    told: Arc<Mutex<Vec<(Instant, Value)>>>,
) {
    let session = format!("hm:{TILE}");
    let Ok(Some(_open)) = read_frame(&mut recv).await else {
        return;
    };
    while let Ok(Some(frame)) = read_frame(&mut recv).await {
        let message: Value = serde_json::from_slice(&frame).unwrap();
        let mut out = vec![];
        if let Some(id) = message.get("id") {
            if message["method"] == "terminal.open" {
                let sam = json!({ "id": "peer:sam", "person": "s", "name": "Sam" });
                out.push(json!([
                    { "event": "terminal.keyboard", "params": [session, sam] },
                    { "event": "terminal.size", "params": [session, 100, 30] },
                    { "event": "terminal.data", "params": [session, "\x1bcHello from the agent"] },
                ]));
            }
            out.push(json!({ "id": id, "result": { "pid": 1, "joined": true } }));
        } else {
            told.lock().unwrap().push((Instant::now(), message.clone()));
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
