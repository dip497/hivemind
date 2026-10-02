//! `hive-net daemon`: this device on the network, for the app (R11, M1). Main listens on a local
//! socket (0600; a named pipe on Windows), starts the daemon with its path, and the daemon
//! connects there; when main goes, so does it. Both ways, each message is JSON in a frame
//! (`frames.rs`), tagged by `t`, in the daemon's protocol `PROTOCOL`: the daemon says which it
//! speaks in `ready`, and main in `hello`, before anything else. The app and hive-net ship
//! together; a daemon told another protocol, or anything before `hello`, stops, saying so.
//!
//! - main → daemon: `hello {v}`, then `admit {devices}` (the devices the access lists let in, which
//!   the gate enforces), `dial {req, peer, addrs, relay}` (a workspace's host, on `hive/ws/1`),
//!   `open {conn, stream, name}` (a stream named `name` on a connection main dialled, by the id main
//!   gives it), `send {conn, stream, data}`, `close {conn, reason?}`, `pair {req, peer, addrs,
//!   relay, hello}` (first contact with a host), `pair-reply {req, reply}` (the answer to someone's
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
//!   named `name`, by the id the daemon gives it), `recv {conn, stream, data}`, `ended {conn,
//!   stream}` (the other device finished the stream or stopped reading it, or it could not be
//!   opened: nothing more goes either way on it), `closed {conn, reason}`, `pair-request {req,
//!   peer, hello}`, `paired {req, reply}`, `nearby {req, devices}`, `published {req}`, `signed
//!   {req, packet}` and `host {req, host, seq, packet}` (null for all when no record is kept;
//!   `packet`, the record as one device hands it to another, only from a lookup server).
//!
//! A stream is named by its first frame and opened by the device that dialled, as many of one name
//! as it likes: a phone opens an `api` stream for each terminal it watches, conversation it follows
//! and call it makes, all on its one connection. Each is its own from its opening to its end, by
//! its id: its frames go to it alone, both ways. The device that opens a connection's streams
//! names them, so their ids never meet: main for a connection it dialled, the daemon for one it
//! accepted. `data` is the frame's bytes as text, which is all main sends. What the frames mean is
//! main's.

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
    sync::{mpsc, oneshot, Mutex},
};
use tokio_stream::StreamExt;

use crate::{
    frames::{framed, read_frame, write_frame},
    gate::Gate,
    host_record::{self, HostRecord},
    key,
    net::{self, Reach},
    pair,
    ping::{self, Pong},
    ws,
};

/// The protocol main and the daemon speak. 2: a stream is known by its id, and a connection carries
/// any number of streams of one name (1, before it, knew a stream by its name: one of each).
pub const PROTOCOL: u32 = 2;

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
    Send {
        conn: u64,
        stream: u64,
        data: String,
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
    Recv {
        conn: u64,
        stream: u64,
        data: String,
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

/// A device on the local network, as mDNS found it: its id, and what it announces.
#[derive(Debug, Clone, Serialize)]
struct NearbyDevice {
    id: String,
    data: Option<String>,
}

/// One peer connection: the queue its frames are written from, in order, and who opens its
/// streams.
struct Link {
    out: mpsc::UnboundedSender<Out>,
    /// Whether this device dialled it: then main opens its streams, and the other device never.
    dialled: bool,
}

/// What goes out on a connection, in the order main said it.
enum Out {
    /// A stream main opens, by the id it gives it, and its name.
    Open(u64, String),
    /// A frame on a stream, by its id.
    Frame(u64, Vec<u8>),
    /// Close it, saying why, once everything before has reached the other side.
    Close(String),
}

/// A connection's open streams, by id: the half each one's frames go out on.
type Streams = Arc<Mutex<HashMap<u64, SendStream>>>;

/// How long a close waits for what went before it to be taken by the other side.
const CLOSE_WAIT: Duration = Duration::from_secs(2);

#[derive(Clone)]
struct Daemon {
    endpoint: Endpoint,
    gate: Gate,
    to_main: mpsc::UnboundedSender<ToMain>,
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
        let _ = self.to_main.send(message);
    }

    /// Keep `connection` as a link, and write its frames from a task of its own, in order: on the
    /// streams main opens, when this device `dialled` it; else on those the other device opened.
    fn register(&self, connection: Connection, dialled: bool) -> (u64, Streams) {
        let conn = self.next.fetch_add(1, Ordering::Relaxed);
        let streams: Streams = Arc::default();
        let (out, mut queue) = mpsc::unbounded_channel::<Out>();
        self.links
            .lock()
            .unwrap()
            .insert(conn, Link { out, dialled });
        let daemon = self.clone();
        let writers = streams.clone();
        tokio::spawn(async move {
            while let Some(first) = queue.recv().await {
                // What main sent meanwhile goes in the same write, each stream's frames in order:
                // one packet for a moment's frames, not one for each. The streams main opened
                // meanwhile open first; a close ends it, after them.
                let mut opens: Vec<(u64, String)> = Vec::new();
                let mut writes: Vec<(u64, Vec<u8>)> = Vec::new();
                let mut closing = None;
                let mut next = Some(first);
                while let Some(item) = next.take() {
                    match item {
                        Out::Open(stream, name) => opens.push((stream, name)),
                        Out::Frame(stream, bytes) => {
                            if let Ok(frame) = framed(&bytes) {
                                match writes.iter_mut().find(|(s, _)| *s == stream) {
                                    Some((_, buf)) => buf.extend_from_slice(&frame),
                                    None => writes.push((stream, frame)),
                                }
                            }
                        }
                        Out::Close(reason) => {
                            closing = Some(reason);
                            break;
                        }
                    }
                    next = queue.try_recv().ok();
                }
                for (stream, name) in opens {
                    daemon.open(conn, &connection, &writers, stream, name).await;
                }
                let mut open = writers.lock().await;
                for (stream, bytes) in writes {
                    // One that ended takes nothing more: main was told.
                    let Some(send) = open.get_mut(&stream) else {
                        continue;
                    };
                    if send.write_all(&bytes).await.is_err() {
                        open.remove(&stream);
                        daemon.ended(conn, &connection, stream);
                    }
                }
                if let Some(reason) = closing {
                    // What went before the close reaches the other side first: each stream
                    // finished and taken there (or given up on after a moment), then closed.
                    let _ = tokio::time::timeout(CLOSE_WAIT, async {
                        for send in open.values_mut() {
                            let _ = send.finish();
                        }
                        for send in open.values_mut() {
                            let _ = send.stopped().await;
                        }
                    })
                    .await;
                    connection.close(0u32.into(), reason.as_bytes());
                    break;
                }
            }
        });
        (conn, streams)
    }

    /// Open the stream `name` on `connection`, which this device dialled, as main's `stream`: its
    /// frames go out on it, and the other device's come back to main. Main is told it ended when
    /// it cannot be opened.
    async fn open(
        &self,
        conn: u64,
        connection: &Connection,
        streams: &Streams,
        stream: u64,
        name: String,
    ) {
        // Only this connection's writer opens its streams, one after another.
        if streams.lock().await.contains_key(&stream) {
            eprintln!("hive-net: stream {stream} is open on connection {conn} already");
            return;
        }
        match ws::open(connection, &name).await {
            Ok((send, recv)) => {
                streams.lock().await.insert(stream, send);
                let (reader, streams, connection) =
                    (self.clone(), streams.clone(), connection.clone());
                tokio::spawn(async move {
                    reader
                        .read_stream(conn, &connection, &streams, stream, recv)
                        .await
                });
            }
            Err(_) => self.ended(conn, connection, stream),
        }
    }

    /// A stream the other device opened on `connection`, which this device accepted: named by its
    /// first frame, given an id that main is told with its name, and read until it ends.
    async fn take_stream(
        &self,
        conn: u64,
        connection: &Connection,
        streams: &Streams,
        send: SendStream,
        mut recv: RecvStream,
    ) {
        let Ok(Some(name)) = read_frame(&mut recv).await else {
            return;
        };
        let name = String::from_utf8_lossy(&name).into_owned();
        let stream = self.next.fetch_add(1, Ordering::Relaxed);
        streams.lock().await.insert(stream, send);
        self.tell(ToMain::Opened { conn, stream, name });
        self.read_stream(conn, connection, streams, stream, recv)
            .await;
    }

    /// Hand main each frame that arrives on `stream`, until the other device finishes it or it
    /// fails: then it ends, both ways.
    async fn read_stream(
        &self,
        conn: u64,
        connection: &Connection,
        streams: &Streams,
        stream: u64,
        mut recv: RecvStream,
    ) {
        while let Ok(Some(frame)) = read_frame(&mut recv).await {
            self.tell(ToMain::Recv {
                conn,
                stream,
                data: String::from_utf8_lossy(&frame).into_owned(),
            });
        }
        // Its other half, finished as it goes: nothing more is sent on it.
        if streams.lock().await.remove(&stream).is_some() {
            self.ended(conn, connection, stream);
        }
    }

    /// `stream` ended, its half out let go: main is told, unless the connection is going, which
    /// main is told of instead.
    fn ended(&self, conn: u64, connection: &Connection, stream: u64) {
        if connection.close_reason().is_none() {
            self.tell(ToMain::Ended { conn, stream });
        }
    }

    fn forget(&self, conn: u64, reason: String) {
        if self.links.lock().unwrap().remove(&conn).is_some() {
            self.tell(ToMain::Closed { conn, reason });
        }
    }

    async fn dial(&self, req: u64, peer: String, addrs: Vec<String>, relay: Option<String>) {
        let connected = async {
            let addr = net::addr_of(&peer, &addrs, &relay)?;
            Ok::<_, anyhow::Error>(self.endpoint.connect(addr, ws::ALPN).await?)
        };
        match connected.await {
            Ok(connection) => {
                let (conn, _) = self.register(connection.clone(), true);
                self.tell(ToMain::Dialed { req, conn });
                let reason = connection.closed().await;
                self.forget(conn, reason.to_string());
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
                    let _ = link.out.send(Out::Open(stream, name));
                } else {
                    // The device that dialled opens the streams: this one only answers on them.
                    eprintln!(
                        "hive-net: connection {conn} was not dialled here; {name} not opened"
                    );
                    self.tell(ToMain::Ended { conn, stream });
                }
            }
            FromMain::Send { conn, stream, data } => {
                if let Some(link) = self.links.lock().unwrap().get(&conn) {
                    let _ = link.out.send(Out::Frame(stream, data.into_bytes()));
                }
            }
            FromMain::Close { conn, reason } => {
                let link = self.links.lock().unwrap().remove(&conn);
                if let Some(link) = link {
                    let reason = reason.unwrap_or_else(|| "closed".into());
                    let _ = link.out.send(Out::Close(reason.clone()));
                    self.tell(ToMain::Closed { conn, reason });
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
        let (conn, streams) = d.register(connection.clone(), false);
        d.tell(ToMain::Incoming {
            conn,
            peer: connection.remote_id().to_string(),
        });
        loop {
            match connection.accept_bi().await {
                // Each stream on its own: one whose name is slow to come holds up no other.
                Ok((send, recv)) => {
                    let (d, connection, streams) = (d.clone(), connection.clone(), streams.clone());
                    tokio::spawn(async move {
                        d.take_stream(conn, &connection, &streams, send, recv).await
                    });
                }
                Err(e) => {
                    d.forget(conn, e.to_string());
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
    let (to_main, mut outbox) = mpsc::unbounded_channel::<ToMain>();
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
        while let Some(message) = outbox.recv().await {
            let bytes = serde_json::to_vec(&message).expect("messages serialize");
            if write_frame(&mut writer, &bytes).await.is_err() {
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
        let speaks = match serde_json::from_slice::<FromMain>(&first) {
            Ok(FromMain::Hello { v }) => v,
            _ => 1,
        };
        if speaks != PROTOCOL {
            bail!("the app speaks the daemon's protocol {speaks}, and this hive-net {PROTOCOL}: install the app and hive-net from one release");
        }
    }
    while let Ok(Some(frame)) = read_frame(&mut reader).await {
        match serde_json::from_slice::<FromMain>(&frame) {
            Ok(message) => daemon.handle(message),
            Err(e) => eprintln!("hive-net: a message from main was not understood: {e}"),
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
