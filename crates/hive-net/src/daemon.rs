//! `hive-net daemon`: this device on the network, for the app (R11, M1). Main listens on a local
//! socket (0600; a named pipe on Windows), starts the daemon with its path, and the daemon
//! connects there; when main goes, so does it. Both ways, each message is JSON in a frame
//! (`frames.rs`), tagged by `t`:
//!
//! - main → daemon: `admit {devices}` (the devices the access lists let in, which the gate
//!   enforces), `dial {req, peer, addrs, relay}` (a workspace's host, on `hive/ws/1`),
//!   `send {conn, stream, data}`, `close {conn}`, `pair {req, peer, addrs, relay, hello}` (first
//!   contact with a host) and `pair-reply {req, reply}` (the answer to someone's `pair-request`).
//! - daemon → main: `ready {id, addrs, relay}`, `incoming {conn, peer}`, `dialed {req, conn}`,
//!   `failed {req, error}`, `recv {conn, stream, data}`, `closed {conn, reason}`,
//!   `pair-request {req, peer, hello}` and `paired {req, reply}`.
//!
//! A stream is named by its first frame and opened by the device that dialled; `data` is the
//! frame's bytes as text, which is all main sends. What the frames mean is main's.

use std::{
    collections::{HashMap, HashSet},
    path::Path,
    str::FromStr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use anyhow::{Context, Result};
use iroh::{
    endpoint::{Connection, RecvStream, SendStream},
    protocol::{AcceptError, ProtocolHandler, Router},
    Endpoint, EndpointAddr, EndpointId, SecretKey, TransportAddr,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::{mpsc, oneshot, Mutex},
};

use crate::{
    frames::{read_frame, write_frame},
    gate::Gate,
    net::{self, Reach},
    pair,
    ping::{self, Pong},
    ws,
};

/// How long a host's person has to answer someone asking to join.
const PAIR_ANSWER_WITHIN: Duration = Duration::from_secs(180);

#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case")]
enum FromMain {
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
    Send {
        conn: u64,
        stream: String,
        data: String,
    },
    Close {
        conn: u64,
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
}

#[derive(Debug, Serialize)]
#[serde(tag = "t", rename_all = "kebab-case")]
enum ToMain {
    Ready {
        id: String,
        addrs: Vec<String>,
        relay: Option<String>,
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
    Recv {
        conn: u64,
        stream: String,
        data: String,
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
}

/// One peer connection: what it is, and the queue its frames are written from, in order.
struct Link {
    connection: Connection,
    out: mpsc::UnboundedSender<(String, Vec<u8>)>,
}

#[derive(Clone)]
struct Daemon {
    endpoint: Endpoint,
    gate: Gate,
    to_main: mpsc::UnboundedSender<ToMain>,
    links: Arc<std::sync::Mutex<HashMap<u64, Link>>>,
    next: Arc<AtomicU64>,
    pairs: Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
}

impl Daemon {
    fn tell(&self, message: ToMain) {
        let _ = self.to_main.send(message);
    }

    /// Keep `connection` as a link, and write its frames from a task of its own, in order. The
    /// device that dialled opens each stream the first time main sends on it; the other side
    /// writes only on streams the peer has opened.
    fn register(
        &self,
        connection: Connection,
        dialled: bool,
    ) -> (u64, Arc<Mutex<HashMap<String, SendStream>>>) {
        let conn = self.next.fetch_add(1, Ordering::Relaxed);
        let streams: Arc<Mutex<HashMap<String, SendStream>>> = Arc::default();
        let (out, mut queue) = mpsc::unbounded_channel::<(String, Vec<u8>)>();
        self.links.lock().unwrap().insert(
            conn,
            Link {
                connection: connection.clone(),
                out,
            },
        );
        let daemon = self.clone();
        let writers = streams.clone();
        tokio::spawn(async move {
            while let Some((stream, bytes)) = queue.recv().await {
                let mut open = writers.lock().await;
                if !open.contains_key(&stream) {
                    if !dialled {
                        eprintln!(
                            "hive-net: no stream {stream} on connection {conn}; frame dropped"
                        );
                        continue;
                    }
                    match connection.open_bi().await {
                        Ok((mut send, recv)) => {
                            if write_frame(&mut send, stream.as_bytes()).await.is_err() {
                                continue;
                            }
                            open.insert(stream.clone(), send);
                            let reader = daemon.clone();
                            let name = stream.clone();
                            tokio::spawn(async move { reader.read_stream(conn, name, recv).await });
                        }
                        Err(_) => continue,
                    }
                }
                let send = open.get_mut(&stream).expect("opened above");
                if write_frame(send, &bytes).await.is_err() {
                    open.remove(&stream);
                }
            }
        });
        (conn, streams)
    }

    /// Hand main each frame that arrives on a stream.
    async fn read_stream(&self, conn: u64, stream: String, mut recv: RecvStream) {
        while let Ok(Some(frame)) = read_frame(&mut recv).await {
            self.tell(ToMain::Recv {
                conn,
                stream: stream.clone(),
                data: String::from_utf8_lossy(&frame).into_owned(),
            });
        }
    }

    fn forget(&self, conn: u64, reason: String) {
        if self.links.lock().unwrap().remove(&conn).is_some() {
            self.tell(ToMain::Closed { conn, reason });
        }
    }

    fn addr_of(peer: &str, addrs: &[String], relay: &Option<String>) -> Result<EndpointAddr> {
        let id =
            EndpointId::from_str(peer).with_context(|| format!("{peer} is not a device id"))?;
        let mut addr = EndpointAddr::new(id);
        for a in addrs {
            addr = addr.with_ip_addr(
                a.parse()
                    .with_context(|| format!("{a} is not an address"))?,
            );
        }
        if let Some(url) = relay {
            addr = addr.with_relay_url(url.parse()?);
        }
        Ok(addr)
    }

    async fn dial(&self, req: u64, peer: String, addrs: Vec<String>, relay: Option<String>) {
        let connected = async {
            let addr = Self::addr_of(&peer, &addrs, &relay)?;
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
        let answered = async {
            let addr = Self::addr_of(&peer, &addrs, &relay)?;
            let connection = self.endpoint.connect(addr, pair::ALPN).await?;
            let (mut send, mut recv) = connection.open_bi().await?;
            write_frame(&mut send, serde_json::to_string(&hello)?.as_bytes()).await?;
            send.finish()?;
            let reply = read_frame(&mut recv)
                .await?
                .context("the host closed without answering")?;
            connection.close(0u32.into(), b"done");
            Ok::<_, anyhow::Error>(serde_json::from_slice(&reply)?)
        };
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
            FromMain::Send { conn, stream, data } => {
                if let Some(link) = self.links.lock().unwrap().get(&conn) {
                    let _ = link.out.send((stream, data.into_bytes()));
                }
            }
            FromMain::Close { conn } => {
                let link = self.links.lock().unwrap().remove(&conn);
                if let Some(link) = link {
                    link.connection.close(0u32.into(), b"closed");
                    self.tell(ToMain::Closed {
                        conn,
                        reason: "closed".into(),
                    });
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
                Ok((send, mut recv)) => {
                    let Ok(Some(name)) = read_frame(&mut recv).await else {
                        continue;
                    };
                    let name = String::from_utf8_lossy(&name).into_owned();
                    streams.lock().await.insert(name.clone(), send);
                    let reader = d.clone();
                    tokio::spawn(async move { reader.read_stream(conn, name, recv).await });
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

/// Run the daemon for main, whose socket is at `socket`, until main goes.
pub async fn run(socket: &Path, key: SecretKey, reach: Reach) -> Result<()> {
    let (reader, writer) = connect(socket)
        .await
        .with_context(|| format!("cannot reach main at {}", socket.display()))?;
    let gate = Gate::default();
    let endpoint = net::endpoint_with(
        key,
        &reach,
        vec![ws::ALPN.to_vec(), pair::ALPN.to_vec(), ping::ALPN.to_vec()],
        gate.clone(),
    )
    .await?;
    let (to_main, mut outbox) = mpsc::unbounded_channel::<ToMain>();
    let daemon = Daemon {
        endpoint: endpoint.clone(),
        gate,
        to_main,
        links: Arc::default(),
        next: Arc::new(AtomicU64::new(1)),
        pairs: Arc::default(),
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

    if matches!(reach, Reach::Relays(_)) {
        endpoint.online().await;
    }
    let here = endpoint.addr();
    daemon.tell(ToMain::Ready {
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
    });

    let mut reader = reader;
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
