// hive-net's daemon as main drives it (R11): each test plays main for two devices, a host and a
// guest, over the local socket (`daemon.rs`). A device the host admits connects, and frames pass
// both ways on named streams, in order; one it does not admit is refused, and one it stops
// admitting loses its connection within a second and cannot come back; anyone may ask to pair,
// and the host's main answers. A host says at its network's lookup server which workspaces it
// hosts (M3), and a device on another network reads it there.
#![cfg(unix)]

mod support;

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
    /// The network's lookup server, as the daemon said when it was ready.
    lookup: Option<String>,
}

impl Drop for Main {
    fn drop(&mut self) {
        let _ = self.daemon.kill();
        let _ = self.daemon.wait();
    }
}

impl Main {
    async fn start(root: &Path, name: &str) -> Main {
        Self::start_with(root, name, &[]).await
    }

    /// A daemon started with `extra` arguments (a network profile).
    async fn start_with(root: &Path, name: &str, extra: &[&str]) -> Main {
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
            .args(extra)
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
            lookup: None,
        };
        let ready = main.next("ready").await;
        main.id = ready["id"].as_str().unwrap().to_string();
        main.addrs = ready["addrs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_str().unwrap().to_string())
            .collect();
        main.lookup = ready["lookup"].as_str().map(str::to_string);
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

    /// The next message of any of the kinds `ts`, waiting up to thirty seconds.
    async fn next_of(&mut self, ts: &[&str]) -> Value {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(i) = self
                .held
                .iter()
                .position(|m| ts.iter().any(|t| m["t"] == *t))
            {
                return self.held.remove(i).unwrap();
            }
            let left = deadline
                .checked_duration_since(Instant::now())
                .unwrap_or_else(|| panic!("no {ts:?} message"));
            let frame = tokio::time::timeout(left, read_frame(&mut self.stream))
                .await
                .unwrap_or_else(|_| panic!("no {ts:?} message"))
                .unwrap()
                .unwrap();
            self.held.push_back(serde_json::from_slice(&frame).unwrap());
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
async fn an_admitted_device_connects_frames_pass_both_ways_in_order_and_main_closes_saying_why() {
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
        (conn.clone(), json!("api"), json!("answer"))
    );

    // Main closes a connection saying why, and the other side reads it.
    host.send(json!({ "t": "close", "conn": host_conn, "reason": "removed" }))
        .await;
    assert_eq!(host.next("closed").await["reason"], json!("removed"));
    let closed = guest.next("closed").await;
    assert_eq!(closed["conn"], conn);
    assert!(
        closed["reason"].as_str().unwrap().contains("removed"),
        "{closed}"
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

#[tokio::test(flavor = "multi_thread")]
async fn when_main_goes_the_daemon_closes_its_connections_so_the_other_side_hears_at_once_and_exits(
) {
    use tokio::io::AsyncWriteExt;
    let root = temp();
    let mut host = Main::start(&root, "host").await;
    let mut guest = Main::start(&root, "guest").await;
    host.send(json!({ "t": "admit", "devices": [guest.id] }))
        .await;
    guest
        .send(json!({ "t": "dial", "req": 1, "peer": host.id, "addrs": host.addr_list() }))
        .await;
    let conn = guest.next("dialed").await["conn"].clone();
    guest
        .send(json!({ "t": "send", "conn": conn, "stream": "api", "data": "hello" }))
        .await;
    host.next("recv").await;

    let gone = Instant::now();
    host.stream.shutdown().await.unwrap();
    let closed = guest.next("closed").await;
    assert_eq!(closed["conn"], conn);
    assert!(
        gone.elapsed() < Duration::from_secs(2),
        "heard after {:?}: {closed}",
        gone.elapsed()
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while host.daemon.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "the daemon outlived main");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_device_on_the_local_network_reaches_a_host_elsewhere_through_the_relay_its_link_names() {
    struct Relay(std::process::Child);
    impl Drop for Relay {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let root = temp();
    let mut relay = Relay(
        std::process::Command::new(BIN)
            .args(["serve", "--relay", "--bind", "127.0.0.1:0"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let mut line = String::new();
    std::io::BufRead::read_line(
        &mut std::io::BufReader::new(relay.0.stdout.take().unwrap()),
        &mut line,
    )
    .unwrap();
    let url = line
        .trim()
        .strip_prefix("relay serving on ")
        .unwrap()
        .to_string();
    // Two networks that meet only at the relay: the host's profile names it; the guest is on its
    // local network, whose profile names no relay, with mDNS off so nothing is found nearby.
    let admin = iroh::SecretKey::from_bytes(&[7u8; 32]);
    let profile = |name: &str, relays: &[&str]| {
        let body = json!({
            "v": 1, "name": name, "admin": admin.public().to_string(),
            "relays": relays.iter().map(|u| json!({ "url": u })).collect::<Vec<_>>(),
            "local": { "mdns": false },
        })
        .to_string();
        let file = root.join(format!("{name}.json"));
        let signed = hive_net::profile::sign(&body, &admin).unwrap();
        fs::write(&file, serde_json::to_string(&signed).unwrap()).unwrap();
        file
    };
    let (elsewhere, here) = (profile("elsewhere", &[&url]), profile("here", &[]));
    let mut host =
        Main::start_with(&root, "host", &["--profile", elsewhere.to_str().unwrap()]).await;
    let mut guest = Main::start_with(&root, "guest", &["--profile", here.to_str().unwrap()]).await;
    host.send(json!({ "t": "admit", "devices": [guest.id] }))
        .await;

    guest
        .send(json!({ "t": "dial", "req": 1, "peer": host.id, "addrs": [], "relay": url }))
        .await;
    let dialed = guest.next_of(&["dialed", "failed"]).await;
    assert_eq!(dialed["t"], "dialed", "{dialed}");
    guest
        .send(json!({ "t": "send", "conn": dialed["conn"], "stream": "api", "data": "hello" }))
        .await;
    assert_eq!(host.next("recv").await["data"], "hello");
    drop(relay);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_host_says_at_its_lookup_server_that_it_hosts_a_workspace_and_a_device_elsewhere_reads_it_there(
) {
    let root = temp();
    let relay = support::start(&["serve", "--relay", "--bind", "127.0.0.1:0"], &[]);
    let relay = (relay.after("relay serving on "), relay);
    let lookup = support::start(
        &[
            "serve",
            "--lookup",
            "--data",
            root.join("server").to_str().unwrap(),
            "--bind",
            "127.0.0.1:0",
            "--lookup-limit",
            "off",
        ],
        &[],
    );
    let lookup = (lookup.after("lookup serving on "), lookup);
    let mut host =
        Main::start_with(&root, "host", &["--relay", &relay.0, "--lookup", &lookup.0]).await;
    assert_eq!(host.lookup.as_deref(), Some(lookup.0.as_str()));
    // The host holds the person key whose workspace it is; the workspace's key derives from it.
    let person: [u8; 32] = rand::random();
    let hex: String = person.iter().map(|b| format!("{b:02x}")).collect();
    fs::write(root.join("host/identity/person.key"), format!("{hex}\n")).unwrap();
    let workspace = "00112233445566778899aabbccddeeff";
    let key = hive_net::key::workspace_key(&iroh::SecretKey::from_bytes(&person), workspace)
        .unwrap()
        .public()
        .to_string();

    // A device on the local network alone, with no lookup server of its own: it asks the one an
    // invite names. Nothing said yet, nobody hosts the workspace.
    let mut guest = Main::start(&root, "guest").await;
    assert_eq!(guest.lookup, None);
    let ask = |req: u64| json!({ "t": "resolve-host", "req": req, "key": key, "lookup": lookup.0 });
    guest.send(ask(1)).await;
    let none = guest.next("host").await;
    assert!(none["host"].is_null() && none["seq"].is_null(), "{none}");

    host.send(json!({ "t": "host-record", "req": 2, "workspace": workspace, "seq": 1 }))
        .await;
    let said = host.next_of(&["published", "failed"]).await;
    assert_eq!(said["t"], "published", "{said}");
    guest.send(ask(3)).await;
    let found = guest.next("host").await;
    assert_eq!(found["host"], host.id.as_str());
    assert_eq!(found["seq"], 1);

    // Asked with no lookup server named, and none on its network, it cannot say.
    guest
        .send(json!({ "t": "resolve-host", "req": 4, "key": key }))
        .await;
    let cannot = guest.next_of(&["host", "failed"]).await;
    assert_eq!(cannot["t"], "failed", "{cannot}");
    assert!(cannot["error"]
        .as_str()
        .unwrap()
        .contains("no lookup server"));
    let _ = fs::remove_dir_all(&root);
}
