//! The phone page (docs/design/phone-browser-2026-10-03.md §10): hive-web's files, served from a
//! folder at `/phone/`, so a person opens hivemind in their phone's browser from their own server,
//! over the HTTPS it already has. Static files only: what the page says, it says to the person's
//! devices through the relay, never to this server.

use std::{
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use anyhow::{Context, Result};
use bytes::Bytes;
use http_body_util::Full;
use hyper::{header, Method, Request, Response, StatusCode};

/// Where the page is served.
pub const PREFIX: &str = "/phone";

/// What the page may load and talk to: its own files, and the relays and access services its
/// pairing link names, wherever they are.
const POLICY: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; \
    connect-src 'self' https: wss: http: ws:; img-src 'self' data:; base-uri 'none'; \
    frame-ancestors 'none'; form-action 'none'";

/// What the frame a view is shown in may do (docs/design/phone-browser-2026-10-03.md §11.6): run
/// its own scripts and frame the view, both on its own origin; nothing from the network.
const SHELL_POLICY: &str = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; \
    frame-src 'self'; base-uri 'none'; form-action 'none'";

/// The folder the page is served from.
#[derive(Debug, Clone)]
pub struct Pages {
    dir: PathBuf,
    /// The port views are shown on, the page's host there being their origin.
    views: Option<u16>,
}

/// The frame views are shown in, on an origin of their own: the page's host on another port. All
/// it serves is that frame; a view's files come from the page, through its service worker.
#[derive(Debug, Clone)]
pub struct ViewShell {
    dir: PathBuf,
}

impl Pages {
    /// The page in `dir`, which holds its `index.html`.
    pub fn open(dir: &Path) -> Result<Self> {
        let dir = dir
            .canonicalize()
            .with_context(|| format!("no folder {}", dir.display()))?;
        anyhow::ensure!(
            dir.join("index.html").is_file(),
            "{} has no index.html: build the page with crates/hive-web/build.sh",
            dir.display()
        );
        Ok(Self { dir, views: None })
    }

    /// The frame views are shown in, from the page's `view/`.
    pub fn view_shell(&self) -> Result<ViewShell> {
        let dir = self.dir.join("view");
        anyhow::ensure!(
            dir.join("index.html").is_file(),
            "{} has no index.html: build the page with crates/hive-web/build.sh",
            dir.display()
        );
        Ok(ViewShell { dir })
    }

    /// Views are shown on `port`.
    pub fn with_views(self, port: u16) -> Self {
        Self {
            views: Some(port),
            ..self
        }
    }

    /// The answer to `req`, whose path is under [`PREFIX`].
    pub async fn handle<B>(&self, req: &Request<B>) -> Response<Full<Bytes>> {
        if !matches!(*req.method(), Method::GET | Method::HEAD) {
            return plain(StatusCode::METHOD_NOT_ALLOWED, "GET only");
        }
        let path = req.uri().path();
        let Some(rest) = path.strip_prefix(PREFIX) else {
            return plain(StatusCode::NOT_FOUND, "not found");
        };
        // The service worker's scope is the folder: `/phone` alone would put the page outside it.
        if rest.is_empty() {
            return Response::builder()
                .status(StatusCode::PERMANENT_REDIRECT)
                .header(header::LOCATION, format!("{PREFIX}/"))
                .body(Full::new(Bytes::new()))
                .expect("a response is well formed");
        }
        let name = match rest.trim_start_matches('/') {
            "" => "index.html",
            name => name,
        };
        if name == "views.json" {
            let port = self.views.map_or("null".into(), |p| p.to_string());
            return Response::builder()
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::CACHE_CONTROL, "no-store")
                .body(Full::new(Bytes::from(format!("{{\"port\":{port}}}"))))
                .expect("a response is well formed");
        }
        // The frame views are shown in is served on their origin alone.
        if name == "view" || name.starts_with("view/") {
            return plain(StatusCode::NOT_FOUND, "not found");
        }
        let policy = match (self.views, host_of(req)) {
            // The host the page was asked for: behind a proxy, only the request says it.
            (Some(port), Some(host)) => format!("{POLICY}; frame-src {host}:{port}"),
            _ => POLICY.to_string(),
        };
        serve(&self.dir, name, req, &policy).await
    }
}

impl ViewShell {
    /// The answer to `req`, on the views' origin.
    pub async fn handle<B>(&self, req: &Request<B>) -> Response<Full<Bytes>> {
        let name = match req.uri().path().trim_start_matches('/') {
            "" => "index.html",
            name => name,
        };
        // A view may register a service worker here: only this one, whose scope is a view's.
        let worker = req.headers().contains_key("service-worker");
        let mut answer = if !matches!(*req.method(), Method::GET | Method::HEAD) {
            plain(StatusCode::METHOD_NOT_ALLOWED, "GET only")
        } else if worker && name != "sw.js" {
            plain(StatusCode::NOT_FOUND, "not found")
        } else {
            // Framed by the page alone, which is on the same host.
            let ancestors =
                host_of(req).map_or("'none'".into(), |h| format!("http://{h}:* https://{h}:*"));
            serve(
                &self.dir,
                name,
                req,
                &format!("{SHELL_POLICY}; frame-ancestors {ancestors}"),
            )
            .await
        };
        // A view framing a missing page here would get a document of this origin with no rules.
        if !answer
            .headers()
            .contains_key(header::CONTENT_SECURITY_POLICY)
        {
            answer.headers_mut().insert(
                header::CONTENT_SECURITY_POLICY,
                header::HeaderValue::from_static("default-src 'none'; sandbox"),
            );
        }
        answer
    }
}

/// The host `req` was sent to, without its port; none when it is not a plain name or address.
fn host_of<B>(req: &Request<B>) -> Option<String> {
    let host = match req.uri().host() {
        Some(host) => host.to_string(),
        None => {
            let said = req.headers().get(header::HOST)?.to_str().ok()?;
            match said.strip_prefix('[') {
                Some(v6) => format!("[{}]", v6.split(']').next()?),
                None => said.split(':').next()?.to_string(),
            }
        }
    };
    let plain = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']');
    (!host.is_empty() && host.chars().all(plain)).then_some(host)
}

/// `name` in `dir`, as `req` asks for it, under `policy`.
async fn serve<B>(dir: &Path, name: &str, req: &Request<B>, policy: &str) -> Response<Full<Bytes>> {
    // Names the page has: no way out of the folder, nothing hidden.
    if name
        .split('/')
        .any(|s| s.is_empty() || s.starts_with('.') || s.contains('\\'))
    {
        return plain(StatusCode::NOT_FOUND, "not found");
    }
    let file = dir.join(name);
    let Ok(meta) = tokio::fs::metadata(&file).await else {
        return plain(StatusCode::NOT_FOUND, "not found");
    };
    if !meta.is_file() {
        return plain(StatusCode::NOT_FOUND, "not found");
    }
    let changed = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis());
    let tag = format!("\"{:x}-{:x}\"", meta.len(), changed);
    let answer = Response::builder()
        .header(header::CONTENT_TYPE, kind_of(name))
        // Asked again each time, so a new page is had at once; the service worker serves it
        // when the server cannot be reached.
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::ETAG, &tag)
        .header(header::CONTENT_SECURITY_POLICY, policy)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header(header::VARY, "accept-encoding");
    let same = req
        .headers()
        .get(header::IF_NONE_MATCH)
        .is_some_and(|v| v.as_bytes() == tag.as_bytes());
    if same {
        return answer
            .status(StatusCode::NOT_MODIFIED)
            .body(Full::new(Bytes::new()))
            .expect("a response is well formed");
    }
    // The wasm is a megabyte compressed and three not: the compressed copy build.sh made.
    let accepts = |coding: &str| {
        req.headers()
            .get(header::ACCEPT_ENCODING)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.split(',').any(|c| c.trim().starts_with(coding)))
    };
    let mut answer = answer;
    let mut body = None;
    for (coding, ext) in [("br", "br"), ("gzip", "gz")] {
        if !accepts(coding) {
            continue;
        }
        let packed = PathBuf::from(format!("{}.{ext}", file.display()));
        // One older than its file is of what the file was.
        let current = tokio::fs::metadata(&packed)
            .await
            .and_then(|m| m.modified())
            .is_ok_and(|at| meta.modified().is_ok_and(|of| at >= of));
        if !current {
            continue;
        }
        if let Ok(bytes) = tokio::fs::read(&packed).await {
            answer = answer.header(header::CONTENT_ENCODING, coding);
            body = Some(bytes);
            break;
        }
    }
    let bytes = match body {
        Some(bytes) => bytes,
        None => match tokio::fs::read(&file).await {
            Ok(bytes) => bytes,
            Err(_) => return plain(StatusCode::NOT_FOUND, "not found"),
        },
    };
    let bytes = if *req.method() == Method::HEAD {
        Bytes::new()
    } else {
        Bytes::from(bytes)
    };
    answer
        .body(Full::new(bytes))
        .expect("a response is well formed")
}

fn plain(status: StatusCode, text: &'static str) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain")
        .body(Full::new(Bytes::from_static(text.as_bytes())))
        .expect("a response is well formed")
}

/// What a file is, by its name: `application/wasm` is what lets a browser compile it as it comes.
fn kind_of(name: &str) -> &'static str {
    match name.rsplit_once('.').map_or("", |(_, ext)| ext) {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "webmanifest" => "application/manifest+json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    fn get(path: &str) -> Request<()> {
        Request::get(path)
            .header(header::ACCEPT_ENCODING, "gzip, br")
            .body(())
            .unwrap()
    }

    #[tokio::test]
    async fn the_page_is_served_from_its_folder_and_nothing_outside_it() {
        let root = std::env::temp_dir().join(format!("hive-net-pages-{}", std::process::id()));
        let dir = root.join("www");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), "<p>hi").unwrap();
        std::fs::write(dir.join("a.wasm"), "raw").unwrap();
        std::fs::write(dir.join("a.wasm.br"), "packed").unwrap();
        std::fs::write(dir.join("b.js.br"), "stale").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(dir.join("b.js"), "new").unwrap();
        std::fs::write(dir.join(".env"), "secret").unwrap();
        std::fs::write(root.join("outside"), "secret").unwrap();
        let pages = Pages::open(&dir).unwrap();

        let index = pages.handle(&get("/phone/")).await;
        assert_eq!(index.status(), 200);
        assert_eq!(
            index.headers()[header::CONTENT_TYPE],
            "text/html; charset=utf-8"
        );
        assert!(index
            .headers()
            .contains_key(header::CONTENT_SECURITY_POLICY));
        let moved = pages.handle(&get("/phone")).await;
        assert_eq!(moved.headers()[header::LOCATION], "/phone/");

        let wasm = pages.handle(&get("/phone/a.wasm")).await;
        assert_eq!(wasm.headers()[header::CONTENT_TYPE], "application/wasm");
        assert_eq!(wasm.headers()[header::CONTENT_ENCODING], "br");
        let changed = pages.handle(&get("/phone/b.js")).await;
        assert!(!changed.headers().contains_key(header::CONTENT_ENCODING));

        let tag = index.headers()[header::ETAG].clone();
        let again = Request::get("/phone/index.html")
            .header(header::IF_NONE_MATCH, tag)
            .body(())
            .unwrap();
        assert_eq!(pages.handle(&again).await.status(), 304);

        for path in [
            "/phone/../outside",
            "/phone/.env",
            "/phone/%2e%2e/outside",
            "/phone//etc/passwd",
        ] {
            assert_eq!(pages.handle(&get(path)).await.status(), 404, "{path}");
        }
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn views_are_framed_from_their_own_origin_alone_and_by_the_pages_host_alone() {
        let dir = std::env::temp_dir().join(format!("hive-net-views-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("view")).unwrap();
        std::fs::write(dir.join("index.html"), "<p>page").unwrap();
        std::fs::write(dir.join("view/index.html"), "<p>frame").unwrap();
        std::fs::write(dir.join("view/shell.js"), "").unwrap();
        std::fs::write(dir.join("view/sw.js"), "").unwrap();
        let body = |r: Response<Full<Bytes>>| async move {
            String::from_utf8(r.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap()
        };
        let policy = |r: &Response<Full<Bytes>>| {
            r.headers()[header::CONTENT_SECURITY_POLICY]
                .to_str()
                .unwrap()
                .to_string()
        };
        let pages = Pages::open(&dir).unwrap();
        assert_eq!(
            body(pages.handle(&get("/phone/views.json")).await).await,
            r#"{"port":null}"#
        );
        let shell = pages.view_shell().unwrap();
        let pages = pages.with_views(4443);
        assert_eq!(
            body(pages.handle(&get("/phone/views.json")).await).await,
            r#"{"port":4443}"#
        );
        let page = Request::get("/phone/")
            .header(header::HOST, "relay.example")
            .body(())
            .unwrap();
        assert!(policy(&pages.handle(&page).await).ends_with("; frame-src relay.example:4443"));
        // On the page's origin the frame would run a view where the device key is kept.
        assert_eq!(
            pages.handle(&get("/phone/view/index.html")).await.status(),
            404
        );

        let at = |host: &str| {
            Request::get("/")
                .header(header::HOST, host)
                .body(())
                .unwrap()
        };
        let framed = shell.handle(&at("relay.example:4443")).await;
        let said = policy(&framed);
        assert!(said.starts_with("default-src 'none';"), "{said}");
        assert!(
            said.ends_with("frame-ancestors http://relay.example:* https://relay.example:*"),
            "{said}"
        );
        assert_eq!(body(framed).await, "<p>frame");
        let v6 = policy(&shell.handle(&at("[::1]:4443")).await);
        assert!(
            v6.ends_with("frame-ancestors http://[::1]:* https://[::1]:*"),
            "{v6}"
        );
        let forged = policy(&shell.handle(&at("a; frame-ancestors *")).await);
        assert!(forged.ends_with("frame-ancestors 'none'"), "{forged}");
        let missing = shell.handle(&get("/../index.html")).await;
        assert_eq!(missing.status(), 404);
        assert_eq!(policy(&missing), "default-src 'none'; sandbox");
        let registering = |path: &str| {
            Request::get(path)
                .header("service-worker", "script")
                .body(())
                .unwrap()
        };
        assert_eq!(shell.handle(&registering("/sw.js")).await.status(), 200);
        assert_eq!(shell.handle(&registering("/shell.js")).await.status(), 404);
        assert_eq!(shell.handle(&get("/shell.js")).await.status(), 200);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
