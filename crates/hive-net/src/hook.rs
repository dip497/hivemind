//! `hive-net hook <socket>`: an agent's hook, as a pipe to the host's hook door
//! (spec/hook-protocol.md "The native hook"). It sends what the hook was given and prints what
//! comes back, so what a hook says is the host's alone. It starts no runtime, and always exits 0 so
//! the agent never fails on it.

use std::{
    env,
    io::{self, Read, Write},
    os::unix::net::UnixStream,
    time::Duration,
};

/// How long a hook that asks for nothing waits for the host to take its event.
const EVENT_WAIT: Duration = Duration::from_millis(1500);

/// The variables the host reads: the tile, its token and the entry's event.
fn passed(name: &str) -> bool {
    name == "HIVEMIND_TILE" || name == "HCP_TOKEN" || name.starts_with("HIVE_EVENT")
}

pub fn run(sock: Option<&str>) {
    let mut stdin = Vec::new();
    let _ = io::stdin().read_to_end(&mut stdin);
    let Some(sock) = sock else { return };
    let vars: serde_json::Map<String, serde_json::Value> = env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .filter(|(k, _)| passed(k))
        .map(|(k, v)| (k, v.into()))
        .collect();
    let line = serde_json::json!({ "env": vars, "stdin": String::from_utf8_lossy(&stdin) });
    let Ok(mut c) = UnixStream::connect(sock) else {
        return;
    };
    // One that answers waits as long as the agent lets it: the agent's own prompt runs meanwhile,
    // and the agent ending this process is what tells the host to let go.
    if env::var("HIVE_EVENT_ANSWER").as_deref() != Ok("1") {
        let _ = c.set_read_timeout(Some(EVENT_WAIT));
    }
    if writeln!(c, "{line}").is_err() {
        return;
    }
    let mut said = Vec::new();
    if c.read_to_end(&mut said).is_ok() {
        let mut out = io::stdout();
        let _ = out.write_all(&said);
        let _ = out.flush();
    }
}
