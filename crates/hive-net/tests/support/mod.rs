// What the server-role tests share: running hive-net, reading what it prints, and asking a server
// over HTTP as anyone could.

#![allow(dead_code)]

use rcgen::{BasicConstraints, CertificateParams, CertifiedIssuer, IsCa, KeyPair};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

pub const BIN: &str = env!("CARGO_BIN_EXE_hive-net");

/// A hive-net of ours, stopped when the test is done with it, and the lines it prints.
pub struct Running {
    child: Child,
    lines: mpsc::Receiver<String>,
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Running {
    /// The next line it prints that starts with `prefix`, without the prefix.
    pub fn after(&self, prefix: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let line = self
                .lines
                .recv_timeout(left)
                .unwrap_or_else(|_| panic!("nothing printed starting {prefix:?}"));
            if let Some(rest) = line.strip_prefix(prefix) {
                return rest.to_string();
            }
        }
    }
}

/// Start `hive-net <args>`, with `env` set.
pub fn start(args: &[&str], env: &[(&str, &str)]) -> Running {
    let mut child = Command::new(BIN)
        .args(args)
        .envs(env.iter().copied())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, lines) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if tx.send(line.unwrap_or_default()).is_err() {
                break;
            }
        }
    });
    Running { child, lines }
}

/// Run `hive-net <args>` to its end, with `env` set; one still running after a minute (a server
/// that started where it should have refused to) is stopped, and fails as killed.
pub fn hive_net(args: &[&str], env: &[(&str, &str)]) -> Output {
    let mut child = Command::new(BIN)
        .args(args)
        .envs(env.iter().copied())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let all_of = |mut from: Box<dyn Read + Send>| {
        thread::spawn(move || {
            let mut all = Vec::new();
            let _ = from.read_to_end(&mut all);
            all
        })
    };
    let stdout = all_of(Box::new(child.stdout.take().unwrap()));
    let stderr = all_of(Box::new(child.stderr.take().unwrap()));
    let deadline = Instant::now() + Duration::from_secs(60);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            break child.wait().unwrap();
        }
        thread::sleep(Duration::from_millis(20));
    };
    Output {
        status,
        stdout: stdout.join().unwrap(),
        stderr: stderr.join().unwrap(),
    }
}

pub fn text(out: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

pub fn temp(what: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "hive-net-{what}-{}-{:08x}",
        std::process::id(),
        rand::random::<u32>()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// A device: an identity directory holding a device key and a person key, as the app keeps them;
/// and its id.
pub fn device(root: &Path, name: &str) -> (String, String) {
    let dir = root.join(name);
    fs::create_dir_all(&dir).unwrap();
    for file in ["device.key", "person.key"] {
        fs::write(
            dir.join(file),
            format!("{}\n", hex::encode(rand::random::<[u8; 32]>())),
        )
        .unwrap();
    }
    let out = hive_net(&["id", "--identity", dir.to_str().unwrap()], &[]);
    (
        dir.to_str().unwrap().to_string(),
        String::from_utf8(out.stdout).unwrap().trim().to_string(),
    )
}

/// A certificate authority, and a certificate it signed for 127.0.0.1: the CA's file, and the
/// certificate's and its key's.
pub fn certificates(root: &Path) -> (String, String, String) {
    certificates_for(root, &["127.0.0.1"])
}

/// A certificate authority, and a certificate it signed for `names`: the CA's file, and the
/// certificate's and its key's.
pub fn certificates_for(root: &Path, names: &[&str]) -> (String, String, String) {
    let mut ca = CertificateParams::new(Vec::<String>::new()).unwrap();
    ca.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    let ca = CertifiedIssuer::self_signed(ca, KeyPair::generate().unwrap()).unwrap();
    let key = KeyPair::generate().unwrap();
    let cert = CertificateParams::new(names.iter().map(|n| n.to_string()).collect::<Vec<_>>())
        .unwrap()
        .signed_by(&key, &ca)
        .unwrap();
    let file = |name: &str, pem: String| {
        let path = root.join(name);
        fs::write(&path, pem).unwrap();
        path.to_str().unwrap().to_string()
    };
    (
        file("ca.pem", ca.pem()),
        file("cert.pem", cert.pem()),
        file("key.pem", key.serialize_pem()),
    )
}

/// A port nobody listens on now.
pub fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// A plain-HTTP request to `url` (`http://host:port/path`), as anyone could make it, with
/// `headers`: its status and body.
pub fn http(method: &str, url: &str, headers: &[(&str, &str)], body: &[u8]) -> (u16, Vec<u8>) {
    let (addr, path) = url
        .trim_start_matches("http://")
        .split_once('/')
        .unwrap_or((url.trim_start_matches("http://"), ""));
    let mut stream = TcpStream::connect(addr).unwrap();
    let mut request = format!(
        "{method} /{path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).unwrap();
    stream.write_all(body).unwrap();
    let mut response = vec![];
    stream.read_to_end(&mut response).unwrap();
    let status = String::from_utf8_lossy(&response[9..12]).parse().unwrap();
    let start = response
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| i + 4)
        .unwrap_or(response.len());
    (status, response[start..].to_vec())
}

/// Ask until `ok` says yes, for at most `within`.
pub fn eventually(within: Duration, mut ok: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(250));
    }
    false
}
