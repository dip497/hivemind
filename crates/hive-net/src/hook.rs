//! `hive-net hook <socket>`: an agent's hook, as a pipe to the host's hook door
//! (spec/hook-protocol.md "The native hook"). It sends what the hook was given and prints what
//! comes back, so what a hook says is the host's alone. Of the agent's payload it sends only the
//! top-level keys the host named in `HIVE_EVENT_KEEP`, so the host never reads a tool's output. It
//! starts no runtime, and always exits 0 so the agent never fails on it.

use serde_json::value::RawValue;
use std::{
    collections::HashMap,
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

/// The keys of `stdin` named in `keep` (comma separated), each value as the agent wrote it; all of
/// it when nothing is named or it is not an object this reads, so no id is lost.
fn kept(stdin: &[u8], keep: Option<&str>) -> String {
    let whole = || String::from_utf8_lossy(stdin).into_owned();
    let Some(keep) = keep.filter(|k| !k.is_empty()) else {
        return whole();
    };
    let Ok(text) = std::str::from_utf8(stdin) else {
        return whole();
    };
    let Ok(mut all) = serde_json::from_str::<HashMap<String, &RawValue>>(text) else {
        return whole();
    };
    let named: HashMap<String, &RawValue> = keep
        .split(',')
        .filter_map(|k| all.remove_entry(k))
        .collect();
    serde_json::to_string(&named).unwrap_or_else(|_| whole())
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
    let keep = env::var("HIVE_EVENT_KEEP").ok();
    let line = serde_json::json!({ "env": vars, "stdin": kept(&stdin, keep.as_deref()) });
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
