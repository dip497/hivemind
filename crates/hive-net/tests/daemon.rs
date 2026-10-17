// hive-net's daemon as main drives it (R11): each test plays main for two devices, a host and a
// guest, over the local socket (`daemon.rs`). A device the host admits connects, and frames pass
// both ways on the streams main opens, in order; a device that opens many streams of one name on
// its one connection, as a phone does, has each served as its own, and one it ends leaves the
// others as they were; one the host does not admit is refused, and one it stops admitting loses
// its connection within a second and cannot come back; anyone may ask to pair, and the host's main
// answers. A host says at its network's lookup server which workspaces it hosts (M3), and a device
// on another network reads it there; a record one device signs naming another, as a move hands it
// over, is checked against the workspace's key alone. An app that speaks another protocol than the
// daemon's is told so, and the daemon stops.
#![cfg(unix)]

mod support;

use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tokio::net::{UnixListener, UnixStream};

use hive_net::{
    daemon::PROTOCOL,
    frames::{read_frame, write_frame, MAX_FRAME},
    net::{self, Reach},
    ws,
};
use iroh::endpoint::{Connection, RecvStream};

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
        let mut main = Self::launch(root, name, extra, Stdio::inherit()).await;
        main.send(json!({ "t": "hello", "v": PROTOCOL })).await;
        main
    }

    /// A daemon started with `extra` arguments, its errors to `stderr`, once it is ready, before
    /// main says anything.
    async fn launch(root: &Path, name: &str, extra: &[&str], stderr: Stdio) -> Main {
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
            .stderr(stderr)
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
        assert_eq!(ready["v"], PROTOCOL, "{ready}");
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

    /// A message, tagged as one.
    async fn send(&mut self, message: Value) {
        let mut frame = vec![0];
        serde_json::to_writer(&mut frame, &message).unwrap();
        write_frame(&mut self.stream, &frame).await.unwrap();
    }

    /// A message as an app of protocol 2 or before sent it: JSON, with no tag.
    async fn send_untagged(&mut self, message: Value) {
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
            let message = message_of(&frame);
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
            self.held.push_back(message_of(&frame));
        }
    }

    fn addr_list(&self) -> Value {
        json!(self.addrs)
    }

    /// Open the stream `name` as `stream` on `conn`, a connection this device dialled, and send
    /// `data` on it.
    async fn open(&mut self, conn: &Value, stream: u64, name: &str, data: &str) {
        self.send(json!({ "t": "open", "conn": conn, "stream": stream, "name": name }))
            .await;
        self.send_on(conn, stream, data).await;
    }

    async fn send_on(&mut self, conn: &Value, stream: u64, data: &str) {
        let mut frame = vec![1];
        frame.extend_from_slice(&conn.as_u64().unwrap().to_be_bytes());
        frame.extend_from_slice(&stream.to_be_bytes());
        frame.extend_from_slice(data.as_bytes());
        write_frame(&mut self.stream, &frame).await.unwrap();
    }
}

/// A frame from the daemon as a message: a frame that arrived on a stream as `recv`.
fn message_of(frame: &[u8]) -> Value {
    match frame.split_first() {
        Some((0, json)) => serde_json::from_slice(json).unwrap(),
        Some((1, on)) => json!({
            "t": "recv",
            "conn": u64::from_be_bytes(on[..8].try_into().unwrap()),
            "stream": u64::from_be_bytes(on[8..16].try_into().unwrap()),
            "data": String::from_utf8_lossy(&on[16..]),
        }),
        _ => panic!("a frame of no kind: {frame:?}"),
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
async fn an_admitted_device_connects_frames_pass_both_ways_in_order_and_main_closes_saying_why_after_them(
) {
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

    // Main opens each stream it sends on, by an id it gives it.
    guest.open(&conn, 1, "api", "call 0").await;
    for i in 1..100 {
        guest.send_on(&conn, 1, &format!("call {i}")).await;
    }
    guest.open(&conn, 2, "sync", "update").await;
    let incoming = host.next("incoming").await;
    assert_eq!(incoming["peer"], json!(guest.id));
    let host_conn = incoming["conn"].clone();
    // The host's main is told of each as it opens: its name, and the id the daemon gives it there.
    let mut named = HashMap::new();
    for _ in 0..2 {
        let opened = host.next("opened").await;
        assert_eq!(opened["conn"], host_conn);
        let name = opened["name"].as_str().unwrap().to_string();
        named.insert(name, opened["stream"].as_u64().unwrap());
    }
    let mut api = vec![];
    let mut sync = vec![];
    while api.len() < 100 || sync.is_empty() {
        let recv = host.next("recv").await;
        assert_eq!(recv["conn"], host_conn);
        let data = recv["data"].as_str().unwrap().to_string();
        match recv["stream"].as_u64() {
            s if s == Some(named["api"]) => api.push(data),
            s if s == Some(named["sync"]) => sync.push(data),
            other => panic!("a frame on {other:?}"),
        }
    }
    assert_eq!(
        api,
        (0..100).map(|i| format!("call {i}")).collect::<Vec<_>>()
    );
    assert_eq!(sync, ["update"]);

    host.send_on(&host_conn, named["api"], "answer").await;
    let back = guest.next("recv").await;
    assert_eq!(
        (
            back["conn"].clone(),
            back["stream"].clone(),
            back["data"].clone()
        ),
        (conn.clone(), json!(1), json!("answer"))
    );

    // Main closes a connection saying why, and the other side reads it, after everything sent
    // before the close (a workspace's host says where it moved, then closes: M3): more than goes
    // out at once, so some of it is still on its way when main asks.
    // The guest's main reads as it arrives, as main does.
    let pad = "x".repeat(128 * 1024);
    let size = "last 00 ".len() + pad.len();
    let reading = tokio::spawn(async move {
        let mut last = vec![];
        loop {
            let m = guest.next_of(&["recv", "closed"]).await;
            if m["t"] == "closed" {
                return (last, m);
            }
            let data = m["data"].as_str().unwrap();
            assert_eq!(data.len(), size);
            last.push(data[..7].to_string());
        }
    });
    for i in 0..50 {
        host.send_on(&host_conn, named["sync"], &format!("last {i:02} {pad}"))
            .await;
    }
    host.send(json!({ "t": "close", "conn": host_conn, "reason": "removed" }))
        .await;
    assert_eq!(host.next("closed").await["reason"], json!("removed"));
    let (last, closed) = reading.await.unwrap();
    assert_eq!(
        last,
        (0..50).map(|i| format!("last {i:02}")).collect::<Vec<_>>()
    );
    assert_eq!(closed["conn"], conn);
    assert!(
        closed["reason"].as_str().unwrap().contains("removed"),
        "{closed}"
    );
    fs::remove_dir_all(root).unwrap();
}

/// A phone, as `crates/hive-phone` is one: an endpoint of its own that the host admits, dialling the
/// host on `hive/ws/1` and opening the streams on that connection itself.
async fn phone_of(host: &mut Main) -> (iroh::Endpoint, Connection) {
    let key = iroh::SecretKey::from_bytes(&rand::random::<[u8; 32]>());
    host.send(json!({ "t": "admit", "devices": [key.public().to_string()] }))
        .await;
    let reach = Reach {
        relays: vec![],
        lookup: None,
        mdns: false,
    };
    let endpoint = net::endpoint(key, &reach, vec![]).await.unwrap();
    let at = net::addr_of(&host.id, &host.addrs, &None).unwrap();
    let connection = endpoint.connect(at, ws::ALPN).await.unwrap();
    (endpoint, connection)
}

/// The next frame on `recv`, as text: there within ten seconds, and not the stream's end.
async fn frame_of(recv: &mut RecvStream) -> String {
    let frame = tokio::time::timeout(Duration::from_secs(10), read_frame(recv))
        .await
        .expect("a frame in time")
        .unwrap()
        .expect("a frame, not the stream's end");
    String::from_utf8(frame).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_device_that_opens_many_streams_of_one_name_on_its_connection_has_each_as_its_own_and_one_it_ends_leaves_the_others(
) {
    let root = temp();
    let mut host = Main::start(&root, "host").await;
    let (_phone, connection) = phone_of(&mut host).await;

    // On its one connection, the phone watches a terminal on an `api` stream and follows a
    // conversation on another, as its Agent screen does: each told to main as it opens, by an id of
    // its own, and each frame by that id.
    let (mut watch_out, mut watch_in) = ws::open(&connection, "api").await.unwrap();
    write_frame(&mut watch_out, b"watch t1").await.unwrap();
    let (mut talk_out, mut talk_in) = ws::open(&connection, "api").await.unwrap();
    write_frame(&mut talk_out, b"talk t1").await.unwrap();
    let conn = host.next("incoming").await["conn"].clone();
    let mut asked = HashMap::new();
    for _ in 0..2 {
        let recv = host.next("recv").await;
        assert_eq!(recv["conn"], conn);
        let data = recv["data"].as_str().unwrap().to_string();
        asked.insert(data, recv["stream"].as_u64().unwrap());
    }
    let (watch, talk) = (asked["watch t1"], asked["talk t1"]);
    assert_ne!(watch, talk);
    let mut opened = vec![];
    for _ in 0..2 {
        let m = host.next("opened").await;
        opened.push((m["conn"].clone(), m["stream"].clone(), m["name"].clone()));
    }
    opened.sort_by_key(|(_, stream, _)| stream.as_u64());
    let mut both = [watch, talk];
    both.sort();
    assert_eq!(opened, both.map(|s| (conn.clone(), json!(s), json!("api"))));

    // Main answers each on its own: neither hears the other's.
    host.send_on(&conn, watch, "screen of t1").await;
    host.send_on(&conn, talk, "what t1 said").await;
    assert_eq!(frame_of(&mut watch_in).await, "screen of t1");
    assert_eq!(frame_of(&mut talk_in).await, "what t1 said");

    // A third, for one call, let go once it is answered: main is told it ended, and the other two
    // carry on, both ways.
    let (mut call_out, mut call_in) = ws::open(&connection, "api").await.unwrap();
    write_frame(&mut call_out, b"send t1").await.unwrap();
    let call = host.next("recv").await;
    assert_eq!(call["data"], "send t1");
    let call = call["stream"].as_u64().unwrap();
    host.send_on(&conn, call, "sent").await;
    assert_eq!(frame_of(&mut call_in).await, "sent");
    drop((call_out, call_in));
    let ended = host.next("ended").await;
    assert_eq!(
        (ended["conn"].clone(), ended["stream"].clone()),
        (conn.clone(), json!(call))
    );
    host.send_on(&conn, watch, "more of t1").await;
    host.send_on(&conn, talk, "more said").await;
    assert_eq!(frame_of(&mut watch_in).await, "more of t1");
    assert_eq!(frame_of(&mut talk_in).await, "more said");
    write_frame(&mut talk_out, b"talk on").await.unwrap();
    let recv = host.next("recv").await;
    assert_eq!(
        (recv["stream"].clone(), recv["data"].clone()),
        (json!(talk), json!("talk on"))
    );
    fs::remove_dir_all(root).unwrap();
}

/// The bytes the daemon says the network took on `stream` of `conn`, within `wait`: what main still
/// counts as waiting comes down by them.
async fn took_on(main: &mut Main, conn: &Value, stream: u64, wait: Duration) -> u64 {
    let mut took = 0;
    let deadline = Instant::now() + wait;
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        let Some(m) = main.within("took", left).await else {
            break;
        };
        if m["conn"] == *conn && m["stream"] == stream {
            took += m["n"].as_u64().unwrap();
        } else {
            main.held.push_back(m);
            break;
        }
    }
    took
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stream_the_other_device_stops_reading_holds_up_no_other_and_the_network_takes_only_what_it_can(
) {
    let root = temp();
    let mut host = Main::start(&root, "host").await;
    let (_phone, connection) = phone_of(&mut host).await;
    // A phone watches a terminal on one `api` stream and follows a conversation on another, and
    // stops reading the first (its screen went to the background).
    let (mut watch_out, mut watch_in) = ws::open(&connection, "api").await.unwrap();
    write_frame(&mut watch_out, b"watch t1").await.unwrap();
    let (mut talk_out, mut talk_in) = ws::open(&connection, "api").await.unwrap();
    write_frame(&mut talk_out, b"talk t1").await.unwrap();
    let conn = host.next("incoming").await["conn"].clone();
    let mut asked = HashMap::new();
    for _ in 0..2 {
        let recv = host.next("recv").await;
        asked.insert(
            recv["data"].as_str().unwrap().to_string(),
            recv["stream"].as_u64().unwrap(),
        );
    }
    let (watch, talk) = (asked["watch t1"], asked["talk t1"]);

    // Far more output than the network holds for a reader that does not read.
    let chunk = "x".repeat(64 * 1024);
    let frames = 128;
    for _ in 0..frames {
        host.send_on(&conn, watch, &chunk).await;
    }
    let sent = (frames * chunk.len()) as u64;
    let took = took_on(&mut host, &conn, watch, Duration::from_secs(5)).await;
    assert!(
        took < sent / 2,
        "the network took {took} of {sent} bytes for a stream nobody reads"
    );

    // The conversation still flows, both ways, and a stream the phone opens now is told to main.
    host.send_on(&conn, talk, "what t1 said").await;
    assert_eq!(frame_of(&mut talk_in).await, "what t1 said");
    assert_eq!(
        took_on(&mut host, &conn, talk, Duration::from_secs(10)).await,
        "what t1 said".len() as u64
    );
    let (mut call_out, _call_in) = ws::open(&connection, "api").await.unwrap();
    write_frame(&mut call_out, b"send t1").await.unwrap();
    let opened = host.next("opened").await;
    assert_eq!(opened["conn"], conn);

    // Read again, the stream gets all of it, and main is told all of it was taken.
    let reading = tokio::spawn(async move {
        for _ in 0..frames {
            frame_of(&mut watch_in).await;
        }
    });
    let mut all = took;
    let until = Instant::now() + Duration::from_secs(30);
    while all < sent && Instant::now() < until {
        all += took_on(&mut host, &conn, watch, Duration::from_secs(1)).await;
    }
    reading.await.unwrap();
    assert_eq!(all, sent);
    drop(talk_out);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn main_ends_a_stream_it_opened_and_the_other_device_hears_it_end_while_the_others_of_that_name_carry_on(
) {
    let root = temp();
    let mut host = Main::start(&root, "host").await;
    let mut guest = Main::start(&root, "guest").await;
    host.send(json!({ "t": "admit", "devices": [guest.id] }))
        .await;
    guest
        .send(json!({ "t": "dial", "req": 1, "peer": host.id, "addrs": host.addr_list() }))
        .await;
    let conn = guest.next("dialed").await["conn"].clone();

    // Two windows of a guest's app, each with an `api` stream of its own on the one connection.
    guest.open(&conn, 1, "api", "window a").await;
    guest.open(&conn, 2, "api", "window b").await;
    let host_conn = host.next("incoming").await["conn"].clone();
    let mut by_window = HashMap::new();
    for _ in 0..2 {
        let recv = host.next("recv").await;
        by_window.insert(
            recv["data"].as_str().unwrap().to_string(),
            recv["stream"].as_u64().unwrap(),
        );
    }
    let (a, b) = (by_window["window a"], by_window["window b"]);

    // Window a closes: main ends its stream, and the host's main is told it ended.
    guest
        .send(json!({ "t": "end", "conn": conn, "stream": 1 }))
        .await;
    let ended = host.next("ended").await;
    assert_eq!(
        (ended["conn"].clone(), ended["stream"].clone()),
        (host_conn.clone(), json!(a))
    );

    // Window b's carries on, both ways; the main that ended a's is not told of it again.
    guest.send_on(&conn, 2, "b again").await;
    let recv = host.next("recv").await;
    assert_eq!(
        (recv["stream"].clone(), recv["data"].clone()),
        (json!(b), json!("b again"))
    );
    host.send_on(&host_conn, b, "answer b").await;
    let back = guest.next("recv").await;
    assert_eq!(
        (back["stream"].clone(), back["data"].clone()),
        (json!(2), json!("answer b"))
    );
    assert!(guest
        .within("ended", Duration::from_millis(500))
        .await
        .is_none());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn many_streams_nobody_reads_together_cost_the_host_no_more_than_the_windows() {
    let root = temp();
    let mut host = Main::start(&root, "host").await;
    let (_phone, connection) = phone_of(&mut host).await;
    let mut kept = Vec::new();
    for i in 0..8 {
        let (mut out, recv) = ws::open(&connection, "api").await.unwrap();
        write_frame(&mut out, format!("watch t{i}").as_bytes())
            .await
            .unwrap();
        kept.push((out, recv));
    }
    let conn = host.next("incoming").await["conn"].clone();
    let mut streams = Vec::new();
    for _ in 0..8 {
        streams.push(host.next("recv").await["stream"].as_u64().unwrap());
    }

    // Each stream alone is held by what the phone lets it be sent; together they are held by the
    // phone's receive window and the host's send window, however many streams the link has.
    let chunk = "x".repeat(64 * 1024);
    for &stream in &streams {
        for _ in 0..32 {
            host.send_on(&conn, stream, &chunk).await;
        }
    }
    let mut took = 0;
    let deadline = Instant::now() + Duration::from_secs(5);
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        let Some(m) = host.within("took", left).await else {
            break;
        };
        assert_eq!(m["conn"], conn);
        took += m["n"].as_u64().unwrap();
    }
    assert!(
        took < 4 * 1024 * 1024,
        "the network took {took} bytes for eight streams nobody reads"
    );
    drop(kept);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_device_that_closes_once_its_frames_arrived_is_heard_closing_only_after_main_has_them_all(
) {
    let root = temp();
    let mut host = Main::start(&root, "host").await;
    let (_phone, connection) = phone_of(&mut host).await;
    let (mut out, _recv) = ws::open(&connection, "api").await.unwrap();
    // 2 MB: as much as the host holds for a main that reads nothing meanwhile (its budget, and
    // its network's receive window); the phone could send no more until main reads.
    let pad = "x".repeat(40 * 1024);
    for i in 0..50 {
        write_frame(&mut out, format!("last {i:02} {pad}").as_bytes())
            .await
            .unwrap();
    }
    // The host's network has all of it, though main has not: then the phone hangs up.
    out.finish().unwrap();
    out.stopped().await.unwrap();
    connection.close(0u32.into(), b"done");
    let mut last = vec![];
    loop {
        let m = host.next_of(&["recv", "closed"]).await;
        if m["t"] == "closed" {
            break;
        }
        last.push(m["data"].as_str().unwrap()[..7].to_string());
    }
    assert_eq!(
        last,
        (0..50).map(|i| format!("last {i:02}")).collect::<Vec<_>>()
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_frame_larger_than_a_connections_budget_reaches_main_whole_and_in_order() {
    let root = temp();
    let mut host = Main::start(&root, "host").await;
    let (_phone, connection) = phone_of(&mut host).await;
    let (mut out, _recv) = ws::open(&connection, "api").await.unwrap();
    let big = "b".repeat(4 * 1024 * 1024);
    write_frame(&mut out, big.as_bytes()).await.unwrap();
    write_frame(&mut out, b"after").await.unwrap();
    let first = host.next("recv").await;
    assert_eq!(first["data"].as_str().unwrap().len(), big.len());
    assert_eq!(host.next("recv").await["data"], "after");
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stream_whose_name_is_too_long_is_not_opened_and_one_after_it_is() {
    let root = temp();
    let mut host = Main::start(&root, "host").await;
    let (_phone, connection) = phone_of(&mut host).await;
    let (mut long_out, _long_in) = ws::open(&connection, &"n".repeat(257)).await.unwrap();
    write_frame(&mut long_out, b"hello").await.unwrap();
    let (mut api_out, _api_in) = ws::open(&connection, "api").await.unwrap();
    write_frame(&mut api_out, b"hello").await.unwrap();
    assert_eq!(host.next("opened").await["name"], "api");
    assert!(host.within("opened", Duration::from_secs(2)).await.is_none());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_frame_too_large_to_hand_main_ends_its_stream_and_main_still_hears_the_others() {
    let root = temp();
    let mut host = Main::start(&root, "host").await;
    let (_phone, connection) = phone_of(&mut host).await;
    // As large as a frame between devices may be: with its header, too large for main's socket.
    let (mut huge, mut huge_in) = ws::open(&connection, "api").await.unwrap();
    let sending = tokio::spawn(async move {
        let _ = write_frame(&mut huge, &vec![b'x'; MAX_FRAME]).await;
    });
    tokio::time::timeout(Duration::from_secs(60), sending)
        .await
        .expect("the huge frame is written or refused")
        .unwrap();
    // Its stream ends, both ways.
    let ended = tokio::time::timeout(Duration::from_secs(20), read_frame(&mut huge_in))
        .await
        .expect("the stream ends in time");
    assert!(
        matches!(ended, Ok(None)),
        "{:?}",
        ended.map(|f| f.map(|f| f.len()))
    );
    let (mut out, _recv) = ws::open(&connection, "api").await.unwrap();
    write_frame(&mut out, b"still heard").await.unwrap();
    assert_eq!(host.next("recv").await["data"], "still heard");
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_frame_larger_than_the_budget_arrives_while_other_streams_wait_for_main() {
    let root = temp();
    let mut host = Main::start(&root, "host").await;
    let (_phone, connection) = phone_of(&mut host).await;
    // A welcome begins on one stream; then four others send more than the network holds unread;
    // then the welcome's rest. Main reads nothing for a while, and then all of it.
    let (mut welcome, _w) = ws::open(&connection, "sync").await.unwrap();
    let len = 1536 * 1024;
    welcome.write_all(&(len as u32).to_be_bytes()).await.unwrap();
    welcome.write_all(&vec![b'w'; 100 * 1024]).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut busy = Vec::new();
    for name in ["pty", "api", "pty", "api"] {
        let (mut out, recv) = ws::open(&connection, name).await.unwrap();
        busy.push(tokio::spawn(async move {
            for _ in 0..20 {
                write_frame(&mut out, &vec![b'b'; 64 * 1024]).await.unwrap();
            }
            (out, recv)
        }));
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    let rest = tokio::spawn(async move {
        welcome.write_all(&vec![b'w'; len - 100 * 1024]).await.unwrap();
        welcome
    });
    tokio::time::sleep(Duration::from_secs(2)).await;
    let (mut big, mut small) = (0, 0);
    while big + small < 81 {
        let data = host.next("recv").await["data"].as_str().unwrap().len();
        if data == len {
            big += 1;
        } else if data == 64 * 1024 {
            small += 1;
        }
    }
    assert_eq!((big, small), (1, 80));
    let _ = (rest.await, busy);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_device_that_begins_more_frames_at_once_than_the_host_holds_is_closed_saying_so() {
    let root = temp();
    let mut host = Main::start(&root, "host").await;
    let (_phone, connection) = phone_of(&mut host).await;
    // Three of the largest frames begun on three streams, none finished: the host holds two.
    let mut kept = Vec::new();
    for _ in 0..3 {
        let (mut out, recv) = ws::open(&connection, "api").await.unwrap();
        out.write_all(&((MAX_FRAME - 17) as u32).to_be_bytes())
            .await
            .unwrap();
        out.write_all(&[b'x'; 1024]).await.unwrap();
        kept.push((out, recv));
    }
    let closed = host.next("closed").await;
    assert!(
        closed["reason"]
            .as_str()
            .unwrap()
            .starts_with("sent too much at once"),
        "{closed}"
    );
    let why = tokio::time::timeout(Duration::from_secs(10), connection.closed())
        .await
        .expect("the device is closed too");
    assert!(why.to_string().contains("sent too much at once"), "{why}");
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_app_that_speaks_another_protocol_is_told_so_and_the_daemon_stops() {
    let root = temp();
    // An app of the first release says nothing of its protocol: it admits devices first; one of
    // the second says hello, untagged. One of a later release says it speaks another.
    let firsts = [
        (json!({ "t": "admit", "devices": [] }), 1, false),
        (json!({ "t": "hello", "v": 2 }), 2, false),
        // Untagged is protocol 2 or before, whatever it says.
        (json!({ "t": "hello", "v": PROTOCOL }), 2, false),
        (json!({ "t": "hello", "v": PROTOCOL + 1 }), PROTOCOL + 1, true),
    ];
    for (i, (first, speaks, tagged)) in firsts.into_iter().enumerate() {
        let mut main = Main::launch(&root, &format!("app{i}"), &[], Stdio::piped()).await;
        if tagged {
            main.send(first).await;
        } else {
            main.send_untagged(first).await;
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        let status = loop {
            if let Some(status) = main.daemon.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < deadline, "the daemon kept running");
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        let mut said = String::new();
        std::io::Read::read_to_string(&mut main.daemon.stderr.take().unwrap(), &mut said).unwrap();
        assert!(!status.success());
        assert!(
            said.contains(&format!("protocol {speaks}, and this hive-net {PROTOCOL}")),
            "{said}"
        );
    }
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
    guest.open(&conn, 1, "api", "hello").await;
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
    guest.open(&conn, 1, "api", "hello").await;
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
    guest.open(&dialed["conn"], 1, "api", "hello").await;
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
    // With the record as the server keeps it, to hand on: it says the same, by the workspace's key.
    guest
        .send(json!({ "t": "verify-host", "req": 5, "key": key, "packet": found["packet"] }))
        .await;
    let handed = guest.next_of(&["host", "failed"]).await;
    assert_eq!(
        (handed["host"].clone(), handed["seq"].clone()),
        (json!(host.id), json!(1)),
        "{handed}"
    );

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

#[tokio::test(flavor = "multi_thread")]
async fn a_record_signed_for_a_move_names_the_new_host_and_holds_only_for_its_workspace() {
    let root = temp();
    let mut host = Main::start(&root, "host").await;
    let mut guest = Main::start(&root, "guest").await;
    let person: [u8; 32] = rand::random();
    let hex: String = person.iter().map(|b| format!("{b:02x}")).collect();
    fs::write(root.join("host/identity/person.key"), format!("{hex}\n")).unwrap();
    let workspace = "00112233445566778899aabbccddeeff";
    let key_of = |id: &str| {
        hive_net::key::workspace_key(&iroh::SecretKey::from_bytes(&person), id)
            .unwrap()
            .public()
            .to_string()
    };
    // The device it moves to: the guest's own, as good as any.
    let new_host = guest.id.clone();

    host.send(
        json!({ "t": "sign-host", "req": 1, "workspace": workspace, "seq": 4, "host": new_host }),
    )
    .await;
    let signed = host.next_of(&["signed", "failed"]).await;
    assert_eq!(signed["t"], "signed", "{signed}");
    let packet = signed["packet"].as_str().unwrap().to_string();

    // Anyone with the workspace's key reads it, with no lookup server between them.
    let check = |req: u64, key: &str, packet: &str| json!({ "t": "verify-host", "req": req, "key": key, "packet": packet });
    guest.send(check(2, &key_of(workspace), &packet)).await;
    let read = guest.next_of(&["host", "failed"]).await;
    assert_eq!(read["host"], new_host.as_str(), "{read}");
    assert_eq!(read["seq"], 4);

    // Not another workspace's, and not once a byte of it is changed.
    guest
        .send(check(
            3,
            &key_of("ffeeddccbbaa99887766554433221100"),
            &packet,
        ))
        .await;
    assert_eq!(guest.next_of(&["host", "failed"]).await["t"], "failed");
    let mut bytes = base64::Engine::decode(&base64::prelude::BASE64_STANDARD, &packet).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    let changed = base64::Engine::encode(&base64::prelude::BASE64_STANDARD, &bytes);
    guest.send(check(4, &key_of(workspace), &changed)).await;
    assert_eq!(guest.next_of(&["host", "failed"]).await["t"], "failed");
    let _ = fs::remove_dir_all(&root);
}
