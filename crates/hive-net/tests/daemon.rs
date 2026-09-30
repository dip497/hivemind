// hive-net's daemon as main drives it (R11): each test plays main for two devices, a host and a
// guest, over the local socket (`daemon.rs`). A device the host admits connects, and frames pass
// both ways on named streams, in order; one it does not admit is refused, and one it stops
// admitting loses its connection within a second and cannot come back; anyone may ask to pair,
// and the host's main answers.
#![cfg(unix)]

use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tokio::net::{UnixListener, UnixStream};

use hive_net::frames::{read_frame, write_frame};

const BIN: &str = env!("CARGO_BIN_EXE_hive-net");

/// Main, for one device: the socket the daemon connects to, and the daemon.
struct Main {
    stream: UnixStream,
    daemon: Child,
    /// Messages read while waiting for another kind.
    held: VecDeque<Value>,
    id: String,
    addrs: Vec<String>,
}

impl Drop for Main {
    fn drop(&mut self) {
        let _ = self.daemon.kill();
        let _ = self.daemon.wait();
    }
}

impl Main {
    async fn start(root: &Path, name: &str) -> Main {
        let dir = root.join(name);
        fs::create_dir_all(dir.join("identity")).unwrap();
        let seed: String = (0..32)
            .map(|_| format!("{:02x}", rand::random::<u8>()))
            .collect();
        fs::write(dir.join("identity/device.key"), format!("{seed}\n")).unwrap();
        let socket = dir.join("net.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let daemon = Command::new(BIN)
            .args([
                "daemon",
                "--socket",
                socket.to_str().unwrap(),
                "--identity",
                dir.join("identity").to_str().unwrap(),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let (stream, _) = tokio::time::timeout(Duration::from_secs(30), listener.accept())
            .await
            .expect("the daemon connects")
            .unwrap();
        let mut main = Main {
            stream,
            daemon,
            held: VecDeque::new(),
            id: String::new(),
            addrs: vec![],
        };
        let ready = main.next("ready").await;
        main.id = ready["id"].as_str().unwrap().to_string();
        main.addrs = ready["addrs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_str().unwrap().to_string())
            .collect();
        main
    }

    async fn send(&mut self, message: Value) {
        write_frame(&mut self.stream, &serde_json::to_vec(&message).unwrap())
            .await
            .unwrap();
    }

    /// The next message of kind `t`, waiting up to ten seconds.
    async fn next(&mut self, t: &str) -> Value {
        self.within(t, Duration::from_secs(10))
            .await
            .unwrap_or_else(|| panic!("no {t} message"))
    }

    async fn within(&mut self, t: &str, wait: Duration) -> Option<Value> {
        if let Some(i) = self.held.iter().position(|m| m["t"] == t) {
            return self.held.remove(i);
        }
        let deadline = Instant::now() + wait;
        loop {
            let left = deadline.checked_duration_since(Instant::now())?;
            let frame = tokio::time::timeout(left, read_frame(&mut self.stream))
                .await
                .ok()?
                .unwrap()?;
            let message: Value = serde_json::from_slice(&frame).unwrap();
            if message["t"] == t {
                return Some(message);
            }
            self.held.push_back(message);
        }
    }

    fn addr_list(&self) -> Value {
        json!(self.addrs)
    }
}

fn temp() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "hive-net-daemon-{}-{:08x}",
        std::process::id(),
        rand::random::<u32>()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test(flavor = "multi_thread")]
async fn a_device_the_host_admits_connects_and_frames_pass_both_ways_on_named_streams_in_order() {
    let root = temp();
    let mut host = Main::start(&root, "host").await;
    let mut guest = Main::start(&root, "guest").await;
    host.send(json!({ "t": "admit", "devices": [guest.id] }))
        .await;

    guest
        .send(json!({ "t": "dial", "req": 1, "peer": host.id, "addrs": host.addr_list() }))
        .await;
    let dialed = guest.next("dialed").await;
    assert_eq!(dialed["req"], 1);
    let conn = dialed["conn"].clone();

    for i in 0..100 {
        guest
            .send(
                json!({ "t": "send", "conn": conn, "stream": "api", "data": format!("call {i}") }),
            )
            .await;
    }
    guest
        .send(json!({ "t": "send", "conn": conn, "stream": "sync", "data": "update" }))
        .await;
    let incoming = host.next("incoming").await;
    assert_eq!(incoming["peer"], json!(guest.id));
    let host_conn = incoming["conn"].clone();
    let mut api = vec![];
    let mut sync = vec![];
    while api.len() < 100 || sync.is_empty() {
        let recv = host.next("recv").await;
        assert_eq!(recv["conn"], host_conn);
        match recv["stream"].as_str().unwrap() {
            "api" => api.push(recv["data"].as_str().unwrap().to_string()),
            "sync" => sync.push(recv["data"].as_str().unwrap().to_string()),
            other => panic!("a frame on {other}"),
        }
    }
    assert_eq!(
        api,
        (0..100).map(|i| format!("call {i}")).collect::<Vec<_>>()
    );
    assert_eq!(sync, ["update"]);

    host.send(json!({ "t": "send", "conn": host_conn, "stream": "api", "data": "answer" }))
        .await;
    let back = guest.next("recv").await;
    assert_eq!(
        (
            back["conn"].clone(),
            back["stream"].clone(),
            back["data"].clone()
        ),
        (conn, json!("api"), json!("answer"))
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_device_not_admitted_is_refused_and_one_no_longer_admitted_is_cut_off_within_a_second() {
    let root = temp();
    let mut host = Main::start(&root, "host").await;
    let mut guest = Main::start(&root, "guest").await;

    // Refused at the handshake: the guest's side finishes it, and the connection is closed at once.
    guest
        .send(json!({ "t": "dial", "req": 1, "peer": host.id, "addrs": host.addr_list() }))
        .await;
    let refused = guest.next("closed").await;
    assert!(
        refused["reason"].as_str().unwrap().contains("not admitted"),
        "{refused}"
    );
    assert!(host
        .within("incoming", Duration::from_millis(500))
        .await
        .is_none());
    guest.held.clear();

    host.send(json!({ "t": "admit", "devices": [guest.id] }))
        .await;
    guest
        .send(json!({ "t": "dial", "req": 2, "peer": host.id, "addrs": host.addr_list() }))
        .await;
    let conn = guest.next("dialed").await["conn"].clone();
    guest
        .send(json!({ "t": "send", "conn": conn, "stream": "api", "data": "hello" }))
        .await;
    assert_eq!(host.next("incoming").await["peer"], json!(guest.id));
    host.next("recv").await;

    let removed = Instant::now();
    host.send(json!({ "t": "admit", "devices": [] })).await;
    let closed = guest.next("closed").await;
    assert_eq!(closed["conn"], conn);
    assert!(
        closed["reason"].as_str().unwrap().contains("removed"),
        "{closed}"
    );
    assert!(
        removed.elapsed() < Duration::from_secs(1),
        "cut off after {:?}",
        removed.elapsed()
    );

    guest
        .send(json!({ "t": "dial", "req": 3, "peer": host.id, "addrs": host.addr_list() }))
        .await;
    assert!(guest.next("closed").await["reason"]
        .as_str()
        .unwrap()
        .contains("not admitted"));
    assert!(host
        .within("incoming", Duration::from_millis(500))
        .await
        .is_none());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn anyone_may_ask_to_pair_and_the_hosts_main_answers() {
    let root = temp();
    let mut host = Main::start(&root, "host").await;
    let mut guest = Main::start(&root, "guest").await;

    let hello = json!({ "secret": "s3cret", "name": "Priya" });
    guest.send(json!({ "t": "pair", "req": 7, "peer": host.id, "addrs": host.addr_list(), "hello": hello })).await;
    let asked = host.next("pair-request").await;
    assert_eq!(
        (asked["peer"].clone(), asked["hello"].clone()),
        (json!(guest.id), hello)
    );
    let reply = json!({ "ok": true, "role": "view" });
    host.send(json!({ "t": "pair-reply", "req": asked["req"], "reply": reply }))
        .await;
    let paired = guest.next("paired").await;
    assert_eq!(
        (paired["req"].clone(), paired["reply"].clone()),
        (json!(7), reply)
    );
    fs::remove_dir_all(root).unwrap();
}
