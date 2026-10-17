//! `hive-net daemon`: this device on the network, for the app (R11, M1). Main listens on a local
//! socket (0600; a named pipe on Windows), starts the daemon with its path, and the daemon
//! connects there; when main goes, so does it. Both ways, each frame (`frames.rs`) starts with a
//! tag: `0`, a message in JSON tagged by `t`; `1`, a frame on a stream, its connection and stream
//! (each a u64, big-endian) then its bytes, which is how main sends (`send`) and the daemon hands
//! main (`recv`) what goes between devices. In the daemon's protocol `PROTOCOL`: the daemon says
//! which it speaks in `ready`, and main in `hello`, before anything else. The app and hive-net ship
//! together; a daemon told another protocol, or anything before `hello`, stops, saying so.
//!
//! - main → daemon: `hello {v}`, then `admit {devices}` (the devices the access lists let in, which
//!   the gate enforces), `dial {req, peer, addrs, relay}` (a workspace's host, on `hive/ws/1`),
//!   `open {conn, stream, name}` (a stream named `name` on a connection main dialled, by the id main
//!   gives it), `send` (tag 1), `end {conn, stream}` (nothing more goes on a stream main opened,
//!   once what it sent is written: the other side hears it end), `close {conn, reason?}`, `pair
//!   {req, peer, addrs, relay, hello}` (first contact with a host), `pair-reply {req, reply}` (the answer to someone's
//!   `pair-request`), `advertise {data}` (what this device announces to the devices nearby, by
//!   mDNS; null for nothing), `nearby {req}` (the devices nearby, and what each announces),
//!   `host-record {req, workspace, seq}` (this device hosts the person's workspace `workspace`:
//!   say so at the network's lookup server, signed by the workspace's key, M3), `resolve-host
//!   {req, key, lookup?}` (which device hosts the workspace whose key is `key`, as the lookup
//!   server `lookup`, or the network's, says), `sign-host {req, workspace, seq, host}` (that record
//!   naming `host`, signed here, to hand to another device in a move) and `verify-host {req, key,
//!   packet}` (what a record handed over says, checked against the workspace's key). A host on
//!   another network is dialled through the relay its link names.
//! - daemon → main: `ready {v, id, addrs, relay, lookup}`, `incoming {conn, peer}`, `dialed {req,
//!   conn}`, `failed {req, error}`, `opened {conn, stream, name}` (the other device opened a stream
//!   named `name`, by the id the daemon gives it), `recv` (tag 1), `took {conn,
//!   stream, n}` (`n` bytes of frames main sent on the stream wait here no more: the network took
//!   them, or the stream ended), `ended {conn, stream}` (the other device finished the stream or
//!   stopped reading it, or it could not be opened: nothing more goes either way on it), `closed
//!   {conn, reason}`, `pair-request {req,
//!   peer, hello}`, `paired {req, reply}`, `nearby {req, devices}`, `published {req}`, `signed
//!   {req, packet}` and `host {req, host, seq, packet}` (null for all when no record is kept;
//!   `packet`, the record as one device hands it to another, only from a lookup server).
//!
//! Each stream is written from a task of its own, so one the other device stops reading holds up
//! no other; what main sent waits here until the network takes it, and main counts it by `took`.
//! What arrives is read while main keeps up: while more than `BUDGET` of what arrived on a
//! connection waits to be written to main, no new frame of it is read, so QUIC stops crediting the
//! other device. A frame begun is read to its end: one stream waiting for room never holds up
//! another's frame.
//!
//! A stream is named by its first frame and opened by the device that dialled, as many of one name
//! as it likes: a phone opens an `api` stream for each terminal it watches, conversation it follows
//! and call it makes, all on its one connection. Each is its own from its opening to its end, by
//! its id: its frames go to it alone, both ways. The device that opens a connection's streams
//! names them, so their ids never meet: main for a connection it dialled, the daemon for one it
//! accepted. What the frames mean is main's.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    str::FromStr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use anyhow::{bail, Context, Result};
use iroh::{
    endpoint::{Connection, RecvStream, SendStream},
    endpoint_info::UserData,
    protocol::{AcceptError, ProtocolHandler, Router},
    Endpoint, EndpointId, SecretKey, TransportAddr,
};
use iroh_mdns_address_lookup::{DiscoveryEvent, MdnsAddressLookup};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::{mpsc, oneshot, watch},
};
use tokio_stream::StreamExt;

use crate::{
    frames::{framed, read_body, read_frame, read_len, write_frame, MAX_FRAME},
    gate::Gate,
    host_record::{self, HostRecord},
    key,
    net::{self, Reach},
    pair,
    ping::{self, Pong},
    ws,
};

/// The protocol main and the daemon speak. 2: a stream is known by its id, and a connection carries
/// any number of streams of one name (1, before it, knew a stream by its name: one of each). 3: main
/// ends a stream it opened, and every frame is tagged: a message, or a frame on a stream as bytes.
pub const PROTOCOL: u32 = 3;

/// How long a host's person has to answer someone asking to join.
const PAIR_ANSWER_WITHIN: Duration = Duration::from_secs(180);

#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case")]
enum FromMain {
    /// The protocol main speaks: its first message.
    Hello {
        v: u32,
    },
    Admit {
        devices: Vec<String>,
    },
    Dial {
        req: u64,
        peer: String,
        #[serde(default)]
        addrs: Vec<String>,
        #[serde(default)]
        relay: Option<String>,
    },
    /// A stream main opens, on a connection it dialled, by the id it gives it.
    Open {
        conn: u64,
        stream: u64,
        name: String,
    },
    /// A stream main opened ends, after what was sent on it before.
    End {
        conn: u64,
        stream: u64,
    },
    Close {
        conn: u64,
        /// Why, as the other side reads it ("removed", "left", …); "closed" when not given.
        #[serde(default)]
        reason: Option<String>,
    },
    Pair {
        req: u64,
        peer: String,
        #[serde(default)]
        addrs: Vec<String>,
        #[serde(default)]
        relay: Option<String>,
        hello: Value,
    },
    PairReply {
        req: u64,
        reply: Value,
    },
    Advertise {
        #[serde(default)]
        data: Option<String>,
    },
    Nearby {
        req: u64,
    },
    HostRecord {
        req: u64,
        workspace: String,
        seq: u64,
    },
    ResolveHost {
        req: u64,
        key: String,
        #[serde(default)]
        lookup: Option<String>,
    },
    SignHost {
        req: u64,
        workspace: String,
        seq: u64,
        host: String,
    },
    VerifyHost {
        req: u64,
        key: String,
        packet: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "t", rename_all = "kebab-case")]
enum ToMain {
    Ready {
        /// The protocol this daemon speaks.
        v: u32,
        id: String,
        addrs: Vec<String>,
        relay: Option<String>,
        /// The network's lookup server, if it has one: where this device says which workspaces
        /// it hosts, and where an invite says to look.
        lookup: Option<String>,
    },
    Incoming {
        conn: u64,
        peer: String,
    },
    Dialed {
        req: u64,
        conn: u64,
    },
    Failed {
        req: u64,
        error: String,
    },
    /// The other device opened a stream, by the id the daemon gives it.
    Opened {
        conn: u64,
        stream: u64,
        name: String,
    },
    /// `n` bytes of the frames main sent on a stream wait here no more: the network took them, or
    /// the stream ended and nothing will.
    Took {
        conn: u64,
        stream: u64,
        n: usize,
    },
    /// Nothing more goes either way on a stream.
    Ended {
        conn: u64,
        stream: u64,
    },
    Closed {
        conn: u64,
        reason: String,
    },
    PairRequest {
        req: u64,
        peer: String,
        hello: Value,
    },
    Paired {
        req: u64,
        reply: Value,
    },
    Nearby {
        req: u64,
        devices: Vec<NearbyDevice>,
    },
    Published {
        req: u64,
    },
    Signed {
        req: u64,
        packet: String,
    },
    Host {
        req: u64,
        host: Option<String>,
        seq: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        packet: Option<String>,
    },
}

/// What goes to main: a message, or a frame that arrived on a stream, counted in its connection's
/// budget until it is written.
enum ToMainFrame {
    Message(ToMain),
    OnStream {
        conn: u64,
        stream: u64,
        data: Vec<u8>,
        _counted: Handed,
    },
}

impl ToMainFrame {
    /// Its bytes on main's socket, after its length.
    fn bytes(&self) -> Vec<u8> {
        match self {
            ToMainFrame::Message(message) => {
                let mut bytes = vec![MESSAGE];
                serde_json::to_writer(&mut bytes, message).expect("messages serialize");
                bytes
            }
            ToMainFrame::OnStream {
                conn, stream, data, ..
            } => {
                let mut bytes = Vec::with_capacity(17 + data.len());
                bytes.push(ON_STREAM);
                bytes.extend_from_slice(&conn.to_be_bytes());
                bytes.extend_from_slice(&stream.to_be_bytes());
                bytes.extend_from_slice(data);
                bytes
            }
        }
    }
}

/// A device on the local network, as mDNS found it: its id, and what it announces.
#[derive(Debug, Clone, Serialize)]
struct NearbyDevice {
    id: String,
    data: Option<String>,
}

/// One peer connection: each open stream's frames, by id, to the task that writes them, and who
/// opens its streams.
struct Link {
    connection: Connection,
    streams: HashMap<u64, mpsc::UnboundedSender<Vec<u8>>>,
    /// Whether this device dialled it: then main opens its streams, and the other device never.
    dialled: bool,
    /// Held by each stream's writer: a close waits until every one has written what it has.
    writing: mpsc::Sender<()>,
    written: mpsc::Receiver<()>,
    /// Held by each stream's reader: main is told the connection closed once every one has
    /// handed it what arrived before.
    reading: mpsc::Sender<()>,
    read: mpsc::Receiver<()>,
    /// The bytes that arrived from the other device and wait to be written to main.
    budget: Budget,
}

/// What a stream's writer and reader take from its link: the queue of main's frames for it, what
/// each holds while it runs, and the link's budget for what arrives.
struct ForStream {
    queue: mpsc::UnboundedReceiver<Vec<u8>>,
    writing: mpsc::Sender<()>,
    reading: mpsc::Sender<()>,
    budget: Budget,
}

/// While more than this of what arrived on a connection waits to be written to main, no new frame
/// of it is read, and QUIC stops letting the other device send.
const BUDGET: usize = 1024 * 1024;

/// The bytes of a connection that wait to be written to main.
type Budget = Arc<watch::Sender<usize>>;

/// A frame handed to main, counted in its connection's budget until it is dropped: once written.
struct Handed {
    budget: Budget,
    n: usize,
}

impl Handed {
    fn new(budget: Budget, n: usize) -> Handed {
        budget.send_modify(|waiting| *waiting += n);
        Handed { budget, n }
    }
}

impl Drop for Handed {
    fn drop(&mut self) {
        self.budget.send_modify(|waiting| *waiting -= self.n);
    }
}

/// The largest frame a stream may carry: with its header, it is a frame on main's socket.
const STREAM_FRAME_AT_MOST: usize = MAX_FRAME - 17;

/// The longest stream name: its first frame.
const NAME_AT_MOST: usize = 256;

/// A frame between main and the daemon starts with a tag: JSON, a message tagged by `t`...
const MESSAGE: u8 = 0;
/// ...or a frame on a stream: its connection and stream, each a u64, then its bytes.
const ON_STREAM: u8 = 1;

/// How long a close waits, while nothing more is written, for what went before it to be taken by
/// the other side.
const CLOSE_WAIT: Duration = Duration::from_secs(2);

/// A stream's writer writes at most about this much at once, so that main hears it taken, and a
/// close sees it move, as it goes.
const WRITE_AT_MOST: usize = 256 * 1024;

#[derive(Clone)]
struct Daemon {
    endpoint: Endpoint,
    gate: Gate,
    to_main: mpsc::UnboundedSender<ToMainFrame>,
    links: Arc<std::sync::Mutex<HashMap<u64, Link>>>,
    next: Arc<AtomicU64>,
    pairs: Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    /// The devices mDNS found on the local network, by id, with what each announces.
    nearby: Arc<std::sync::Mutex<HashMap<String, Option<String>>>>,
    /// Where this machine's keys are: the person key a host record is signed with is read there
    /// when it is needed (pairing may have replaced it).
    identity: PathBuf,
    /// The network's lookup server, if it has one.
    lookup: Option<url::Url>,
}

impl Daemon {
    fn tell(&self, message: ToMain) {
        let _ = self.to_main.send(ToMainFrame::Message(message));
    }

    /// Hand main a frame that arrived on `stream`, counted in `budget` until it is written.
    fn hand(&self, conn: u64, stream: u64, data: Vec<u8>, budget: &Budget) {
        let counted = Handed::new(budget.clone(), data.len());
        let _ = self.to_main.send(ToMainFrame::OnStream {
            conn,
            stream,
            data,
            _counted: counted,
        });
    }

    /// Keep `connection` as a link: its streams are main's to open, when this device `dialled` it;
    /// else the other device's.
    fn register(&self, connection: Connection, dialled: bool) -> u64 {
        let conn = self.next.fetch_add(1, Ordering::Relaxed);
        let (writing, written) = mpsc::channel(1);
        let (reading, read) = mpsc::channel(1);
        self.links.lock().unwrap().insert(
            conn,
            Link {
                connection,
                streams: HashMap::new(),
                dialled,
                writing,
                written,
                reading,
                read,
                budget: Arc::new(watch::channel(0).0),
            },
        );
        conn
    }

    /// A queue for the stream `stream` of the link `conn`, which its writer takes frames from; and
    /// what its writer and its reader hold while they run. None when the link is gone.
    fn queue(&self, conn: u64, stream: u64) -> Option<ForStream> {
        let mut links = self.links.lock().unwrap();
        let link = links.get_mut(&conn)?;
        let (frames, queue) = mpsc::unbounded_channel();
        link.streams.insert(stream, frames);
        Some(ForStream {
            queue,
            writing: link.writing.clone(),
            reading: link.reading.clone(),
            budget: link.budget.clone(),
        })
    }

    /// Open the stream `name` on `connection`, which this device dialled, as main's `stream`, and
    /// write main's frames on it; the other device's come back to main. Main is told it ended when
    /// it cannot be opened.
    fn open(&self, conn: u64, connection: Connection, stream: u64, name: String) {
        let Some(ForStream {
            queue,
            writing,
            reading,
            budget,
        }) = self.queue(conn, stream)
        else {
            return;
        };
        let d = self.clone();
        tokio::spawn(async move {
            match ws::open(&connection, &name).await {
                Ok((send, recv)) => {
                    let reader = d.clone();
                    tokio::spawn(async move {
                        reader
                            .read_stream(conn, stream, recv, reading, budget)
                            .await
                    });
                    d.write_stream(conn, stream, send, queue, writing).await;
                }
                Err(_) => {
                    d.end(conn, stream);
                    d.drop_queued(conn, stream, queue);
                }
            }
        });
    }

    /// A stream the other device opened on `connection`, which this device accepted: named by its
    /// first frame, given an id that main is told with its name, written from a task of its own,
    /// and read until it ends.
    async fn take_stream(&self, conn: u64, send: SendStream, mut recv: RecvStream) {
        let Ok(Some(len @ ..=NAME_AT_MOST)) = read_len(&mut recv).await else {
            return;
        };
        let Ok(name) = read_body(&mut recv, len).await else {
            return;
        };
        let name = String::from_utf8_lossy(&name).into_owned();
        let stream = self.next.fetch_add(1, Ordering::Relaxed);
        let Some(ForStream {
            queue,
            writing,
            reading,
            budget,
        }) = self.queue(conn, stream)
        else {
            return;
        };
        let writer = self.clone();
        tokio::spawn(async move { writer.write_stream(conn, stream, send, queue, writing).await });
        self.tell(ToMain::Opened { conn, stream, name });
        self.read_stream(conn, stream, recv, reading, budget).await;
    }

    /// Write the frames main queues for `stream`, in order, each moment's in one write, telling
    /// main how many bytes of them the network took. When the queue ends (main closed the link, or
    /// the other device finished reading) the stream is finished once what it has is written.
    async fn write_stream(
        &self,
        conn: u64,
        stream: u64,
        mut send: SendStream,
        mut queue: mpsc::UnboundedReceiver<Vec<u8>>,
        writing: mpsc::Sender<()>,
    ) {
        while let Some(first) = queue.recv().await {
            let mut took = 0;
            let mut bytes = Vec::new();
            let mut next = Some(first);
            while let Some(frame) = next.take() {
                took += frame.len();
                if let Ok(framed) = framed(&frame) {
                    bytes.extend_from_slice(&framed);
                }
                if bytes.len() < WRITE_AT_MOST {
                    next = queue.try_recv().ok();
                }
            }
            let wrote = send.write_all(&bytes).await.is_ok();
            self.tell(ToMain::Took { conn, stream, n: took });
            let _ = writing.try_send(());
            if !wrote {
                self.end(conn, stream);
                return self.drop_queued(conn, stream, queue);
            }
        }
        let _ = send.finish();
        let _ = send.stopped().await;
    }

    /// The frames still queued for a stream that ended: main is told they are taken, as nothing
    /// will take them.
    fn drop_queued(&self, conn: u64, stream: u64, mut queue: mpsc::UnboundedReceiver<Vec<u8>>) {
        queue.close();
        let mut n = 0;
        while let Ok(frame) = queue.try_recv() {
            n += frame.len();
        }
        if n > 0 {
            self.tell(ToMain::Took { conn, stream, n });
        }
    }

    /// Queue main's frame `data` for `stream` of `conn`. A stream that ended takes nothing more:
    /// main is told it is not waiting.
    fn send(&self, conn: u64, stream: u64, data: Vec<u8>) {
        let links = self.links.lock().unwrap();
        let Some(link) = links.get(&conn) else {
            return;
        };
        let n = data.len();
        let queued = link
            .streams
            .get(&stream)
            .is_some_and(|frames| frames.send(data).is_ok());
        if !queued {
            self.tell(ToMain::Took { conn, stream, n });
        }
    }

    /// Hand main each frame that arrives on `stream`, until the other device finishes it or it
    /// fails: then it ends, both ways.
    async fn read_stream(
        &self,
        conn: u64,
        stream: u64,
        mut recv: RecvStream,
        _reading: mpsc::Sender<()>,
        budget: Budget,
    ) {
        let mut room = budget.subscribe();
        while let Ok(Some(len @ ..=STREAM_FRAME_AT_MOST)) = read_len(&mut recv).await {
            if room.wait_for(|waiting| *waiting < BUDGET).await.is_err() {
                break;
            }
            let Ok(frame) = read_body(&mut recv, len).await else {
                break;
            };
            self.hand(conn, stream, frame, &budget);
        }
        self.end(conn, stream);
    }

    /// `stream` ended: its writer finishes once what is queued is written, and main is told, once,
    /// unless the connection is going, which main is told of instead.
    fn end(&self, conn: u64, stream: u64) {
        let mut links = self.links.lock().unwrap();
        let Some(link) = links.get_mut(&conn) else {
            return;
        };
        if link.streams.remove(&stream).is_some() && link.connection.close_reason().is_none() {
            self.tell(ToMain::Ended { conn, stream });
        }
    }

    /// The other device closed `conn`, or it was lost: main is told, after each stream's reader
    /// has handed it what arrived before. They end once main takes it: nothing more arrives.
    async fn forget(&self, conn: u64, reason: String) {
        let Some(link) = self.links.lock().unwrap().remove(&conn) else {
            return;
        };
        let Link {
            connection,
            streams,
            writing,
            reading,
            mut read,
            ..
        } = link;
        drop((connection, streams, writing, reading));
        read.recv().await;
        self.tell(ToMain::Closed { conn, reason });
    }

    async fn dial(&self, req: u64, peer: String, addrs: Vec<String>, relay: Option<String>) {
        let connected = async {
            let addr = net::addr_of(&peer, &addrs, &relay)?;
            Ok::<_, anyhow::Error>(self.endpoint.connect(addr, ws::ALPN).await?)
        };
        match connected.await {
            Ok(connection) => {
                let conn = self.register(connection.clone(), true);
                self.tell(ToMain::Dialed { req, conn });
                let reason = connection.closed().await;
                self.forget(conn, reason.to_string()).await;
            }
            Err(e) => self.tell(ToMain::Failed {
                req,
                error: format!("{e:#}"),
            }),
        }
    }

    async fn pair(
        &self,
        req: u64,
        peer: String,
        addrs: Vec<String>,
        relay: Option<String>,
        hello: Value,
    ) {
        let answered =
            async { pair::ask(&self.endpoint, net::addr_of(&peer, &addrs, &relay)?, &hello).await };
        match answered.await {
            Ok(reply) => self.tell(ToMain::Paired { req, reply }),
            Err(e) => self.tell(ToMain::Failed {
                req,
                error: format!("{e:#}"),
            }),
        }
    }

    fn handle(&self, message: FromMain) {
        match message {
            FromMain::Admit { devices } => {
                let ids: HashSet<EndpointId> = devices
                    .iter()
                    .filter_map(|d| EndpointId::from_str(d).ok())
                    .collect();
                self.gate.admit(ids);
            }
            FromMain::Dial {
                req,
                peer,
                addrs,
                relay,
            } => {
                let d = self.clone();
                tokio::spawn(async move { d.dial(req, peer, addrs, relay).await });
            }
            // Said once, first: `run` read it.
            FromMain::Hello { .. } => {}
            FromMain::Open { conn, stream, name } => {
                let links = self.links.lock().unwrap();
                let Some(link) = links.get(&conn) else {
                    return;
                };
                if link.dialled {
                    let connection = link.connection.clone();
                    drop(links);
                    self.open(conn, connection, stream, name);
                } else {
                    // The device that dialled opens the streams: this one only answers on them.
                    eprintln!(
                        "hive-net: connection {conn} was not dialled here; {name} not opened"
                    );
                    self.tell(ToMain::Ended { conn, stream });
                }
            }
            FromMain::End { conn, stream } => {
                // Its writer finishes it once what is queued is written; main ended it, so is not told.
                if let Some(link) = self.links.lock().unwrap().get_mut(&conn) {
                    link.streams.remove(&stream);
                }
            }
            FromMain::Close { conn, reason } => {
                let link = self.links.lock().unwrap().remove(&conn);
                if let Some(link) = link {
                    let reason = reason.unwrap_or_else(|| "closed".into());
                    self.tell(ToMain::Closed {
                        conn,
                        reason: reason.clone(),
                    });
                    tokio::spawn(close(link, reason));
                }
            }
            FromMain::Pair {
                req,
                peer,
                addrs,
                relay,
                hello,
            } => {
                let d = self.clone();
                tokio::spawn(async move { d.pair(req, peer, addrs, relay, hello).await });
            }
            FromMain::PairReply { req, reply } => {
                if let Some(answer) = self.pairs.lock().unwrap().remove(&req) {
                    let _ = answer.send(reply);
                }
            }
            FromMain::Advertise { data } => {
                // Too long to announce is the same as nothing to announce.
                let data = data.and_then(|d| UserData::try_from(d).ok());
                self.endpoint.set_user_data_for_address_lookup(data);
            }
            FromMain::Nearby { req } => {
                let devices = self
                    .nearby
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|(id, data)| NearbyDevice {
                        id: id.clone(),
                        data: data.clone(),
                    })
                    .collect();
                self.tell(ToMain::Nearby { req, devices });
            }
            FromMain::HostRecord {
                req,
                workspace,
                seq,
            } => {
                let d = self.clone();
                tokio::spawn(async move {
                    match d.publish_host(&workspace, seq).await {
                        Ok(()) => d.tell(ToMain::Published { req }),
                        Err(e) => d.tell(ToMain::Failed {
                            req,
                            error: format!("{e:#}"),
                        }),
                    }
                });
            }
            FromMain::SignHost {
                req,
                workspace,
                seq,
                host,
            } => match self.sign_host(&workspace, seq, &host) {
                Ok(packet) => self.tell(ToMain::Signed { req, packet }),
                Err(e) => self.tell(ToMain::Failed {
                    req,
                    error: format!("{e:#}"),
                }),
            },
            FromMain::VerifyHost { req, key, packet } => {
                let checked = iroh::PublicKey::from_str(&key)
                    .with_context(|| format!("{key} is not a key"))
                    .and_then(|key| host_record::from_text(&key, &packet));
                match checked {
                    Ok(r) => self.tell(ToMain::Host {
                        req,
                        host: Some(r.host.to_string()),
                        seq: Some(r.seq),
                        packet: None,
                    }),
                    Err(e) => self.tell(ToMain::Failed {
                        req,
                        error: format!("{e:#}"),
                    }),
                }
            }
            FromMain::ResolveHost { req, key, lookup } => {
                let d = self.clone();
                tokio::spawn(async move {
                    match d.resolve_host(&key, lookup.as_deref()).await {
                        Ok(found) => d.tell(ToMain::Host {
                            req,
                            host: found.as_ref().map(|(r, _)| r.host.to_string()),
                            seq: found.as_ref().map(|(r, _)| r.seq),
                            packet: found.map(|(_, text)| text),
                        }),
                        Err(e) => d.tell(ToMain::Failed {
                            req,
                            error: format!("{e:#}"),
                        }),
                    }
                });
            }
        }
    }

    /// Say at the network's lookup server that this device hosts the person's workspace
    /// `workspace`, the `seq`th to: signed by the workspace's key, derived from the person key
    /// kept here now.
    async fn publish_host(&self, workspace: &str, seq: u64) -> Result<()> {
        let lookup = self
            .lookup
            .as_ref()
            .context("this network has no lookup server")?;
        let person = key::person_key(&self.identity)?;
        let signer = key::workspace_key(&person, workspace)?;
        let record = HostRecord {
            host: self.endpoint.id(),
            seq,
        };
        host_record::publish(lookup, &signer, record).await
    }

    /// A record saying that `host` hosts the person's workspace `workspace`, the `seq`th to, signed
    /// by the workspace's key, as one device hands it to another (a move).
    fn sign_host(&self, workspace: &str, seq: u64, host: &str) -> Result<String> {
        let person = key::person_key(&self.identity)?;
        let signer = key::workspace_key(&person, workspace)?;
        let host = EndpointId::from_str(host).with_context(|| format!("{host} is not a device"))?;
        Ok(host_record::to_text(
            &HostRecord { host, seq }.sign(&signer)?,
        ))
    }

    /// Which device hosts the workspace whose key is `key`, as the lookup server `lookup` (or the
    /// network's) has it.
    async fn resolve_host(
        &self,
        key: &str,
        lookup: Option<&str>,
    ) -> Result<Option<(HostRecord, String)>> {
        let workspace =
            iroh::PublicKey::from_str(key).with_context(|| format!("{key} is not a key"))?;
        let lookup = match lookup {
            Some(url) => url::Url::parse(url).context("the lookup server's URL")?,
            None => self
                .lookup
                .clone()
                .context("no lookup server to ask: this network has none")?,
        };
        host_record::resolve(&lookup, workspace).await
    }
}

/// Close `link`, saying why, once what went before has reached the other side: each stream's
/// writer writes what it has and finishes, and the other side takes it (or a moment passes with
/// nothing more written).
async fn close(link: Link, reason: String) {
    let Link {
        connection,
        streams,
        writing,
        mut written,
        ..
    } = link;
    drop((streams, writing));
    while let Ok(Some(())) = tokio::time::timeout(CLOSE_WAIT, written.recv()).await {}
    connection.close(0u32.into(), reason.as_bytes());
}

/// Keep `nearby` to the devices mDNS finds on the local network, and what each announces.
async fn watch_nearby(
    lookup: MdnsAddressLookup,
    nearby: Arc<std::sync::Mutex<HashMap<String, Option<String>>>>,
) {
    let mut events = lookup.subscribe().await;
    while let Some(event) = events.next().await {
        match event {
            DiscoveryEvent::Discovered { endpoint_info, .. } => {
                let data = endpoint_info.data.user_data().map(|d| d.to_string());
                nearby
                    .lock()
                    .unwrap()
                    .insert(endpoint_info.endpoint_id.to_string(), data);
            }
            DiscoveryEvent::Expired { endpoint_id } => {
                nearby.lock().unwrap().remove(&endpoint_id.to_string());
            }
            _ => {}
        }
    }
}

/// Someone's connection to a workspace here.
#[derive(Clone)]
struct WsHost(Daemon);

impl std::fmt::Debug for WsHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WsHost")
    }
}

impl ProtocolHandler for WsHost {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        let d = &self.0;
        let conn = d.register(connection.clone(), false);
        d.tell(ToMain::Incoming {
            conn,
            peer: connection.remote_id().to_string(),
        });
        loop {
            match connection.accept_bi().await {
                // Each stream on its own: one whose name is slow to come holds up no other.
                Ok((send, recv)) => {
                    let d = d.clone();
                    tokio::spawn(async move { d.take_stream(conn, send, recv).await });
                }
                Err(e) => {
                    d.forget(conn, e.to_string()).await;
                    return Ok(());
                }
            }
        }
    }
}

/// An error of ours, as the router takes one.
fn io(e: anyhow::Error) -> AcceptError {
    std::io::Error::other(format!("{e:#}")).into()
}

/// Someone new asking to join: main answers.
#[derive(Clone)]
struct PairHost(Daemon);

impl std::fmt::Debug for PairHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PairHost")
    }
}

impl ProtocolHandler for PairHost {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        let d = &self.0;
        let (mut send, mut recv) = connection.accept_bi().await?;
        let hello = read_frame(&mut recv).await.map_err(io)?.unwrap_or_default();
        let hello: Value = serde_json::from_slice(&hello).unwrap_or(Value::Null);
        let req = d.next.fetch_add(1, Ordering::Relaxed);
        let (answer, answered) = oneshot::channel();
        d.pairs.lock().unwrap().insert(req, answer);
        d.tell(ToMain::PairRequest {
            req,
            peer: connection.remote_id().to_string(),
            hello,
        });
        let reply = match tokio::time::timeout(PAIR_ANSWER_WITHIN, answered).await {
            Ok(Ok(reply)) => reply,
            _ => {
                d.pairs.lock().unwrap().remove(&req);
                serde_json::json!({ "ok": false, "error": "no answer" })
            }
        };
        let bytes = serde_json::to_vec(&reply).map_err(AcceptError::from_err)?;
        write_frame(&mut send, &bytes).await.map_err(io)?;
        send.finish()?;
        let _ = tokio::time::timeout(Duration::from_secs(5), connection.closed()).await;
        Ok(())
    }
}

/// Run the daemon for main, whose socket is at `socket`, until main goes; this machine's keys
/// are in `identity`.
pub async fn run(socket: &Path, identity: &Path, key: SecretKey, reach: Reach) -> Result<()> {
    let (reader, writer) = connect(socket)
        .await
        .with_context(|| format!("cannot reach main at {}", socket.display()))?;
    let gate = Gate::default();
    let (endpoint, lookup) = net::endpoint_with(
        key,
        &reach,
        vec![ws::ALPN.to_vec(), pair::ALPN.to_vec(), ping::ALPN.to_vec()],
        gate.clone(),
    )
    .await?;
    let nearby: Arc<std::sync::Mutex<HashMap<String, Option<String>>>> = Arc::default();
    if let Some(lookup) = lookup {
        tokio::spawn(watch_nearby(lookup, nearby.clone()));
    }
    let (to_main, mut outbox) = mpsc::unbounded_channel::<ToMainFrame>();
    let daemon = Daemon {
        endpoint: endpoint.clone(),
        gate,
        to_main,
        links: Arc::default(),
        next: Arc::new(AtomicU64::new(1)),
        pairs: Arc::default(),
        nearby,
        identity: identity.to_path_buf(),
        lookup: reach.lookup.clone(),
    };
    let router = Router::builder(endpoint.clone())
        .accept(ws::ALPN, WsHost(daemon.clone()))
        .accept(pair::ALPN, PairHost(daemon.clone()))
        .accept(ping::ALPN, Pong)
        .spawn();

    let mut writer = writer;
    let writing = tokio::spawn(async move {
        while let Some(frame) = outbox.recv().await {
            if write_frame(&mut writer, &frame.bytes()).await.is_err() {
                break;
            }
        }
    });

    // A relay that cannot be reached does not keep the app off the local network.
    if !reach.relays.is_empty() {
        let _ = tokio::time::timeout(Duration::from_secs(5), endpoint.online()).await;
    }
    let here = endpoint.addr();
    daemon.tell(ToMain::Ready {
        v: PROTOCOL,
        id: endpoint.id().to_string(),
        addrs: here
            .addrs
            .iter()
            .filter_map(|a| {
                if let TransportAddr::Ip(ip) = a {
                    Some(ip.to_string())
                } else {
                    None
                }
            })
            .collect(),
        relay: here.addrs.iter().find_map(|a| {
            if let TransportAddr::Relay(url) = a {
                Some(url.to_string())
            } else {
                None
            }
        }),
        lookup: daemon.lookup.as_ref().map(|u| u.to_string()),
    });

    let mut reader = reader;
    // Main says first which protocol it speaks. An app that says nothing of it speaks the first.
    if let Ok(Some(first)) = read_frame(&mut reader).await {
        let speaks = match first.split_first() {
            Some((&MESSAGE, json)) => match serde_json::from_slice::<FromMain>(json) {
                Ok(FromMain::Hello { v }) => v,
                _ => 1,
            },
            // An app of protocol 2 or before sends JSON with no tag: `{`.
            _ => match serde_json::from_slice::<FromMain>(&first) {
                Ok(FromMain::Hello { v }) => v.min(2),
                _ => 1,
            },
        };
        if speaks != PROTOCOL {
            bail!("the app speaks the daemon's protocol {speaks}, and this hive-net {PROTOCOL}: install the app and hive-net from one release");
        }
    }
    while let Ok(Some(frame)) = read_frame(&mut reader).await {
        match frame.split_first() {
            Some((&MESSAGE, json)) => match serde_json::from_slice::<FromMain>(json) {
                Ok(message) => daemon.handle(message),
                Err(e) => eprintln!("hive-net: a message from main was not understood: {e}"),
            },
            Some((&ON_STREAM, on)) if on.len() >= 16 => {
                let conn = u64::from_be_bytes(on[..8].try_into().unwrap());
                let stream = u64::from_be_bytes(on[8..16].try_into().unwrap());
                daemon.send(conn, stream, on[16..].to_vec());
            }
            _ => eprintln!("hive-net: a frame from main was not understood"),
        }
    }
    writing.abort();
    router.shutdown().await?;
    Ok(())
}

#[cfg(unix)]
async fn connect(socket: &Path) -> Result<(impl AsyncRead + Unpin, impl AsyncWrite + Unpin)> {
    let stream = tokio::net::UnixStream::connect(socket).await?;
    Ok(tokio::io::split(stream))
}

#[cfg(windows)]
async fn connect(socket: &Path) -> Result<(impl AsyncRead + Unpin, impl AsyncWrite + Unpin)> {
    let pipe = tokio::net::windows::named_pipe::ClientOptions::new().open(socket)?;
    Ok(tokio::io::split(pipe))
}

#[cfg(not(any(unix, windows)))]
async fn connect(_socket: &Path) -> Result<(tokio::io::Empty, tokio::io::Sink)> {
    anyhow::bail!("no local socket on this platform")
}
