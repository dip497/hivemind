//! The server roles (§13.4), which anyone can run for their own devices, on one port, so a network
//! needs one name and one certificate: the relay, which carries traffic between devices that
//! cannot reach each other directly; the lookup server (`lookup.rs`), where devices say how they
//! are reached and workspaces where they are hosted; the access role (`access.rs`), which says
//! who may use the relay; and the push role (`push.rs`), which tells phones what happens on the
//! person's devices. Requests go by path: `/pkarr/…` and `/dns-query` to the lookup server,
//! `/access/…` to the access role, `/push/…` to the push role, the rest to the relay. Plain HTTP (a network inside a building,
//! or behind a proxy that ends TLS), or HTTPS with a certificate from Let's Encrypt or one kept in
//! files; then the relay also answers QUIC address discovery and the captive-portal check, as
//! iroh's own relay server does.

use std::{
    convert::Infallible,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result};
use bytes::Bytes;
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Full, Limited};
use hyper::{
    body::Incoming, server::conn::http1, service::service_fn, service::Service as _, Request,
    Response,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use iroh_relay::server::{
    http_server::RelayServiceWithNotify, reloading_resolver, streams::MaybeTlsStream, CertConfig,
    DynAccessControl, QuicConfig, RelayConfig, RelayService, Server as RelayServer, ServerConfig,
    TlsConfig,
};
use rustls::server::ResolvesServerCert;
use tokio::{
    net::{TcpListener, TcpStream},
    sync::Notify,
    task::JoinHandle,
    time::timeout,
};
use tokio_rustls_acme::{caches::DirCache, AcmeAcceptor, AcmeConfig};
use tokio_stream::StreamExt;

use crate::{
    access,
    lookup::{Lookup, PutLimit},
    push,
};

/// How long a connection has for its TLS handshake, and a request for its headers.
const PATIENCE: Duration = Duration::from_secs(30);
/// How often certificate files are read again, so a renewed one is used.
const RELOAD: Duration = Duration::from_secs(60 * 60);
/// The largest request passed on to the lookup server: a record is at most 1104 bytes.
const MAX_LOOKUP_BODY: usize = 64 * 1024;

type BoxError = Box<dyn std::error::Error + Send + Sync>;
type Body = UnsyncBoxBody<Bytes, BoxError>;

/// Where an HTTPS certificate comes from.
#[derive(Debug, Clone)]
pub enum Certificate {
    /// Let's Encrypt, for these names (TLS-ALPN-01, so the front must be reached on port 443),
    /// kept in `cache` between runs.
    LetsEncrypt {
        domains: Vec<String>,
        contact: Option<String>,
        cache: PathBuf,
    },
    /// A chain and its key in PEM files, read again every hour.
    Files { cert: PathBuf, key: PathBuf },
}

/// What to serve, and where.
pub struct Options {
    /// Where the front listens.
    pub bind: SocketAddr,
    /// HTTPS with this certificate; plain HTTP when none.
    pub certificate: Option<Certificate>,
    /// The relay, admitting what this says.
    pub relay: Option<Arc<dyn DynAccessControl>>,
    /// With HTTPS: where the relay answers QUIC address discovery (UDP)…
    pub quic_bind: SocketAddr,
    /// …and the captive-portal check (plain HTTP).
    pub http_bind: SocketAddr,
    /// The lookup server: where it keeps its records, where it answers DNS, and whether it holds
    /// back publishing from one address.
    pub lookup: Option<(PathBuf, Option<SocketAddr>, bool)>,
    /// The server's name, when it has one: the zone its lookup server answers DNS for.
    pub domain: Option<String>,
    /// The access role.
    pub access: Option<access::Service>,
    /// The push role.
    pub push: Option<push::Service>,
}

/// The roles, serving.
pub struct Serving {
    addr: SocketAddr,
    https: bool,
    relay: Option<RelayServer>,
    lookup: Option<Lookup>,
    front: JoinHandle<()>,
}

/// The address that is every address: IPv6's, which takes IPv4 as well, where this machine has
/// IPv6; IPv4's where it has none (a container often has none).
pub fn any_address() -> IpAddr {
    let v6 = IpAddr::from(std::net::Ipv6Addr::UNSPECIFIED);
    match std::net::UdpSocket::bind(SocketAddr::new(v6, 0)) {
        Ok(_) => v6,
        Err(_) => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
    }
}

/// How a connection's bytes are read.
#[derive(Clone)]
enum Accept {
    Plain,
    Tls(tokio_rustls::TlsAcceptor),
    Acme(AcmeAcceptor, Arc<rustls::ServerConfig>),
}

/// What answers the requests.
struct Front {
    relay: Option<RelayService>,
    lookup: Option<(SocketAddr, Option<Arc<PutLimit>>)>,
    access: Option<access::Service>,
    push: Option<push::Service>,
    /// For passing requests on to the lookup server, on this machine.
    local: reqwest::Client,
}

impl Serving {
    pub async fn spawn(opts: Options) -> Result<Self> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut accept = Accept::Plain;
        let mut tls = None;
        if let Some(certificate) = &opts.certificate {
            let (resolver, acme): (Arc<dyn ResolvesServerCert>, _) = match certificate {
                Certificate::Files { cert, key } => (
                    reloading_resolver(&provider, cert.clone(), key.clone(), RELOAD)
                        .await
                        .map_err(|e| anyhow::anyhow!("the certificate: {e}"))?,
                    None,
                ),
                Certificate::LetsEncrypt {
                    domains,
                    contact,
                    cache,
                } => {
                    let client = crate::net::trusted().client_config(provider.clone())?;
                    let mut config =
                        AcmeConfig::new_with_client_tls_config(domains, Arc::new(client))
                            .directory_lets_encrypt(true)
                            .cache(DirCache::new(cache.clone()));
                    if let Some(contact) = contact {
                        config = config.contact([format!("mailto:{contact}")]);
                    }
                    let state = config.state();
                    (state.resolver().clone(), Some(state))
                }
            };
            let mut config = rustls::ServerConfig::builder_with_provider(provider.clone())
                .with_safe_default_protocol_versions()?
                .with_no_client_auth()
                .with_cert_resolver(resolver);
            config.alpn_protocols = vec![b"http/1.1".to_vec()];
            let config = Arc::new(config);
            accept = match acme {
                Some(mut state) => {
                    let acceptor = state.acceptor();
                    tokio::spawn(async move {
                        while let Some(event) = state.next().await {
                            match event {
                                Ok(ok) => eprintln!("hive-net: certificate: {ok:?}"),
                                Err(e) => eprintln!("hive-net: certificate: {e:?}"),
                            }
                        }
                    });
                    Accept::Acme(acceptor, config.clone())
                }
                None => Accept::Tls(tokio_rustls::TlsAcceptor::from(config.clone())),
            };
            tls = Some(config);
        }

        let relay = match &opts.relay {
            None => None,
            Some(admits) => {
                // The relay's own listener is on this machine only and unused: the front serves
                // its requests (`RelayService` is made to be embedded).
                let here = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0);
                let mut relay = RelayConfig::new(here);
                relay.access = admits.clone();
                let mut config = ServerConfig::default();
                if let Some(tls) = &tls {
                    relay.http_bind_addr = opts.http_bind;
                    relay.tls = Some(TlsConfig::new(
                        here,
                        CertConfig::Manual {
                            server_config: (**tls).clone(),
                        },
                    ));
                    config.quic = Some(QuicConfig::new(opts.quic_bind));
                }
                config.relay = Some(relay);
                Some(RelayServer::spawn(config).await.context("the relay")?)
            }
        };
        let lookup = match &opts.lookup {
            None => None,
            Some((dir, dns, limited)) => {
                Some(Lookup::spawn(dir, *dns, opts.domain.as_deref(), *limited).await?)
            }
        };

        let listener = TcpListener::bind(opts.bind)
            .await
            .with_context(|| format!("cannot listen on {}", opts.bind))?;
        let addr = listener.local_addr()?;
        let front = Arc::new(Front {
            relay: relay.as_ref().and_then(|r| r.relay_service().cloned()),
            lookup: lookup.as_ref().map(|l| (l.http_addr(), l.limit())),
            access: opts.access.clone(),
            push: opts.push.clone(),
            local: reqwest::Client::builder().no_proxy().build()?,
        });
        let front = tokio::spawn(async move {
            loop {
                let Ok((tcp, peer)) = listener.accept().await else {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                };
                let front = front.clone();
                let accept = accept.clone();
                tokio::spawn(async move { front.connection(tcp, peer, accept).await });
            }
        });
        Ok(Self {
            addr,
            https: tls.is_some(),
            relay,
            lookup,
            front,
        })
    }

    /// Where the front listens.
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// Whether it serves HTTPS.
    pub fn https(&self) -> bool {
        self.https
    }

    /// Where the lookup server answers DNS, when it runs.
    pub fn dns_addr(&self) -> Option<SocketAddr> {
        self.lookup.as_ref().map(Lookup::dns_addr)
    }

    /// Serve until a role stops, or the process is told to.
    pub async fn run(self) -> Result<()> {
        let relay = async {
            match self.relay {
                Some(mut relay) => relay.join().await?.context("the relay stopped"),
                None => std::future::pending().await,
            }
        };
        let lookup = async {
            match self.lookup {
                Some(lookup) => lookup.run().await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            stopped = relay => stopped,
            stopped = lookup => stopped,
            _ = self.front => anyhow::bail!("the front stopped"),
            _ = tokio::signal::ctrl_c() => Ok(()),
        }
    }
}

fn answer(status: u16, text: &'static str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "text/plain")
        .body(boxed(Full::new(Bytes::from_static(text.as_bytes()))))
        .expect("a response is well formed")
}

fn boxed(body: Full<Bytes>) -> Body {
    body.map_err(|never| -> BoxError { match never {} })
        .boxed_unsync()
}

/// `req` as the role under `prefix` reads it: its path without the prefix.
fn under(req: Request<Incoming>, prefix: &str) -> Request<Incoming> {
    let (mut parts, body) = req.into_parts();
    let whole = parts
        .uri
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/");
    let rest = whole.strip_prefix(prefix).unwrap_or(whole);
    let rest = if rest.starts_with('/') {
        rest.to_string()
    } else {
        format!("/{rest}")
    };
    parts.uri = rest
        .parse()
        .unwrap_or_else(|_| hyper::Uri::from_static("/"));
    Request::from_parts(parts, body)
}

impl Front {
    async fn connection(self: Arc<Self>, tcp: TcpStream, peer: SocketAddr, accept: Accept) {
        let _ = tcp.set_nodelay(true);
        let io = match accept {
            Accept::Plain => MaybeTlsStream::Plain(tcp),
            Accept::Tls(acceptor) => match timeout(PATIENCE, acceptor.accept(tcp)).await {
                Ok(Ok(tls)) => MaybeTlsStream::Tls(tls),
                _ => return,
            },
            Accept::Acme(acceptor, config) => {
                match timeout(PATIENCE, acceptor.accept(tcp)).await {
                    // Let's Encrypt checking this server holds the name: answered.
                    Ok(Ok(None)) => return,
                    Ok(Ok(Some(start))) => {
                        match timeout(PATIENCE, start.into_stream(config)).await {
                            Ok(Ok(tls)) => MaybeTlsStream::Tls(tls),
                            _ => return,
                        }
                    }
                    _ => return,
                }
            }
        };
        let relay = self
            .relay
            .clone()
            .map(|service| RelayServiceWithNotify::new(service, Arc::new(Notify::new())));
        let front = self.clone();
        let _ = http1::Builder::new()
            .timer(TokioTimer::new())
            .header_read_timeout(PATIENCE)
            .serve_connection(
                TokioIo::new(io),
                service_fn(move |req| {
                    let front = front.clone();
                    let relay = relay.clone();
                    async move { Ok::<_, Infallible>(front.route(req, peer.ip(), relay).await) }
                }),
            )
            .with_upgrades()
            .await;
    }

    async fn route(
        &self,
        req: Request<Incoming>,
        peer: IpAddr,
        relay: Option<RelayServiceWithNotify>,
    ) -> Response<Body> {
        let path = req.uri().path();
        if let Some((lookup, limit)) = &self.lookup {
            if path.starts_with("/pkarr/") || path == "/dns-query" {
                let publishing = req.method() == hyper::Method::PUT;
                if publishing
                    && limit
                        .as_ref()
                        .is_some_and(|limit| !limit.allow(crate::limit::source(peer)))
                {
                    return answer(429, "too many records from this address: wait a little");
                }
                return self.to_lookup(*lookup, req).await;
            }
        }
        if let Some(access) = &self.access {
            if path == "/access" || path.starts_with("/access/") {
                return access.handle(under(req, "/access")).await.map(boxed);
            }
        }
        if let Some(push) = &self.push {
            if path == "/push" || path.starts_with("/push/") {
                return push.handle(under(req, "/push"), peer).await.map(boxed);
            }
        }
        match relay {
            Some(relay) => match relay.call(req).await {
                Ok(response) => response.map(|body| {
                    body.map_err(|never| -> BoxError { match never {} })
                        .boxed_unsync()
                }),
                Err(_) => answer(500, "the relay could not answer"),
            },
            None if path == "/healthz" => answer(200, "ok"),
            None => answer(404, "not found"),
        }
    }

    /// Pass a request on to the lookup server.
    async fn to_lookup(&self, lookup: SocketAddr, req: Request<Incoming>) -> Response<Body> {
        let (parts, body) = req.into_parts();
        let Ok(body) = Limited::new(body, MAX_LOOKUP_BODY).collect().await else {
            return answer(413, "too large");
        };
        let path = parts
            .uri
            .path_and_query()
            .map(|p| p.as_str())
            .unwrap_or("/");
        let mut out = self
            .local
            .request(parts.method.clone(), format!("http://{lookup}{path}"))
            .body(body.to_bytes());
        for (name, value) in &parts.headers {
            if !matches!(
                name.as_str(),
                "host" | "connection" | "content-length" | "transfer-encoding"
            ) {
                out = out.header(name, value);
            }
        }
        let Ok(back) = out.send().await else {
            return answer(502, "the lookup server did not answer");
        };
        let mut response = Response::builder().status(back.status().as_u16());
        for (name, value) in back.headers() {
            if !matches!(
                name.as_str(),
                "connection" | "content-length" | "transfer-encoding"
            ) {
                response = response.header(name, value);
            }
        }
        let bytes = back.bytes().await.unwrap_or_default();
        response
            .body(boxed(Full::new(bytes)))
            .unwrap_or_else(|_| answer(502, "the lookup server's answer"))
    }
}
