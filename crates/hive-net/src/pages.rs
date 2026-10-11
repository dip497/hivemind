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

/// The folder the page is served from.
#[derive(Debug, Clone)]
pub struct Pages {
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
        Ok(Self { dir })
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
        // Names the page has: no way out of the folder, nothing hidden.
        if name
            .split('/')
            .any(|s| s.is_empty() || s.starts_with('.') || s.contains('\\'))
        {
            return plain(StatusCode::NOT_FOUND, "not found");
        }
        let file = self.dir.join(name);
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
            .header(header::CONTENT_SECURITY_POLICY, POLICY)
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
}
