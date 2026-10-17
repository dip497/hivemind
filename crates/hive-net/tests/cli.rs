// hive-net as a person or the app runs it (R10): the id of this machine's device key, which must
// be the id the app shows for the same key (conformance/identity.json); a device found on the local
// network by its id alone; and one reached through a relay `hive-net serve --relay` runs, and not
// once the relay is gone.

use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::mpsc,
    thread,
    time::Duration,
};

const BIN: &str = env!("CARGO_BIN_EXE_hive-net");

/// A process of ours, stopped when the test ends.
struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Start `hive-net <args>` and wait for the first line it prints. It is stopped even when it
/// prints nothing: a process left running would hold the test's output open.
fn start(args: &[&str]) -> (Running, String) {
    let mut running = Running(
        Command::new(BIN)
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let stdout = running.0.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let _ = tx.send(line.unwrap_or_default());
        }
    });
    let first = rx
        .recv_timeout(Duration::from_secs(30))
        .unwrap_or_else(|_| panic!("hive-net {args:?} printed nothing"));
    (running, first)
}

fn hive_net(args: &[&str]) -> Output {
    Command::new(BIN).args(args).output().unwrap()
}

/// An identity directory holding `seed` as its device key, written as the app writes it.
fn identity(root: &Path, name: &str, seed: &str) -> PathBuf {
    let dir = root.join(name);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("device.key"), format!("{seed}\n")).unwrap();
    dir
}

fn temp() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "hive-net-test-{}-{}",
        std::process::id(),
        rand_hex(4)
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn rand_hex(bytes: usize) -> String {
    (0..bytes)
        .map(|_| format!("{:02x}", rand::random::<u8>()))
        .collect()
}

fn text(out: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

#[test]
fn a_device_is_named_by_its_key_as_the_app_names_it_and_a_bad_key_is_never_replaced() {
    let vectors: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/identity.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let root = temp();
    for (i, v) in vectors["ed25519"].as_array().unwrap().iter().enumerate() {
        let dir = identity(&root, &format!("v{i}"), v["seed"].as_str().unwrap());
        let out = hive_net(&["id", "--identity", dir.to_str().unwrap()]);
        assert!(out.status.success(), "{}", text(&out));
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            v["id"].as_str().unwrap()
        );
    }
    // A key file that cannot be read as one is an error, and stays as it was.
    let bad = identity(&root, "bad", "not a key");
    let out = hive_net(&["id", "--identity", bad.to_str().unwrap()]);
    assert!(!out.status.success());
    assert!(text(&out).contains("is not a device key"), "{}", text(&out));
    assert_eq!(
        fs::read_to_string(bad.join("device.key")).unwrap(),
        "not a key\n"
    );
    // No key: nothing is made.
    let none = root.join("none");
    let out = hive_net(&["id", "--identity", none.to_str().unwrap()]);
    assert!(!out.status.success());
    assert!(text(&out).contains("no device key"), "{}", text(&out));
    assert!(!none.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn on_the_local_network_a_device_is_found_by_its_id_alone() {
    let root = temp();
    let a = identity(&root, "a", &rand_hex(32));
    let b = identity(&root, "b", &rand_hex(32));
    let (_a, id) = start(&["run", "--identity", a.to_str().unwrap()]);
    let out = hive_net(&["ping", &id, "--identity", b.to_str().unwrap()]);
    assert!(out.status.success(), "{}", text(&out));
    assert!(
        text(&out).contains(&format!("{id} answered")),
        "{}",
        text(&out)
    );
    assert!(text(&out).contains("directly"), "{}", text(&out));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_device_elsewhere_is_reached_through_a_relay_hive_net_serves_and_not_once_it_is_gone() {
    let root = temp();
    let a = identity(&root, "a", &rand_hex(32));
    let b = identity(&root, "b", &rand_hex(32));
    let (relay, serving) = start(&["serve", "--relay", "--bind", "127.0.0.1:0"]);
    let url = serving
        .strip_prefix("relay serving on ")
        .unwrap_or_else(|| panic!("{serving}"))
        .to_string();
    let (_a, id) = start(&["run", "--identity", a.to_str().unwrap(), "--relay", &url]);
    // B knows only A's id and the relay: no address, and no local network lookup with relays.
    let ping = || {
        hive_net(&[
            "ping",
            &id,
            "--identity",
            b.to_str().unwrap(),
            "--relay",
            &url,
        ])
    };
    let out = ping();
    assert!(out.status.success(), "{}", text(&out));
    assert!(
        text(&out).contains(&format!("{id} answered")),
        "{}",
        text(&out)
    );
    drop(relay);
    let out = ping();
    assert!(
        !out.status.success(),
        "answered with the relay gone: {}",
        text(&out)
    );
    fs::remove_dir_all(root).unwrap();
}

/// An agent's hook through `hive-net hook`: what the agent gave it reaches the door as one line,
/// with the tile's variables and no others, and what the door says back is what it prints.
#[cfg(unix)]
#[test]
fn a_hook_passes_its_payload_and_its_tile_to_the_door_and_prints_the_answer() {
    use std::{io::Write, os::unix::net::UnixListener};
    let sock = temp().join("door.sock");
    let listener = UnixListener::bind(&sock).unwrap();
    let door = thread::spawn(move || {
        let (mut c, _) = listener.accept().unwrap();
        let mut line = String::new();
        BufReader::new(&c).read_line(&mut line).unwrap();
        // Past the wait of a hook that asks for nothing: one that answers is held for as long.
        thread::sleep(Duration::from_secs(2));
        c.write_all(b"{\"decision\":\"allow\"}").unwrap();
        line
    });
    let mut hook = Command::new(BIN)
        .args(["hook", sock.to_str().unwrap()])
        .env_clear()
        .envs([
            ("HIVEMIND_TILE", "hm:t1"),
            ("HCP_TOKEN", "tok"),
            ("HIVE_EVENT", "input.requested"),
            ("HIVE_EVENT_ANSWER", "1"),
            ("ANTHROPIC_API_KEY", "not-for-the-host"),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    hook.stdin
        .take()
        .unwrap()
        .write_all(b"{\"tool_name\":\"Bash\"}")
        .unwrap();
    let out = hook.wait_with_output().unwrap();
    // Before the door's line: a hook that never reached the door leaves it waiting.
    assert_eq!(text(&out), "{\"decision\":\"allow\"}");
    assert!(out.status.success());
    let said: serde_json::Value = serde_json::from_str(&door.join().unwrap()).unwrap();
    assert_eq!(
        said,
        serde_json::json!({
            "env": { "HIVEMIND_TILE": "hm:t1", "HCP_TOKEN": "tok", "HIVE_EVENT": "input.requested", "HIVE_EVENT_ANSWER": "1" },
            "stdin": "{\"tool_name\":\"Bash\"}",
        })
    );
}

/// A hook sends the door only the payload's keys the host named, each as the agent wrote it, so
/// a tool's output never reaches the host; a payload it cannot read goes whole, ids and all.
#[cfg(unix)]
#[test]
fn a_hook_sends_only_the_keys_the_host_named_and_a_payload_it_cannot_read_whole() {
    use std::{io::Write, os::unix::net::UnixListener};
    let said = |payload: &[u8]| -> serde_json::Value {
        let sock = temp().join("door.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let door = thread::spawn(move || {
            let (c, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(&c).read_line(&mut line).unwrap();
            line
        });
        let mut hook = Command::new(BIN)
            .args(["hook", sock.to_str().unwrap()])
            .env_clear()
            .envs([
                ("HIVEMIND_TILE", "hm:t1"),
                ("HIVE_EVENT", "input.resolved"),
                ("HIVE_EVENT_KEEP", "session_id,agent_id,tool_input"),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        hook.stdin.take().unwrap().write_all(payload).unwrap();
        hook.wait().unwrap();
        let line = door.join().unwrap();
        fs::remove_file(&sock).unwrap();
        serde_json::from_str::<serde_json::Value>(&line).unwrap()["stdin"].clone()
    };
    let output = "y".repeat(1 << 20);
    let payload = format!(
        r#"{{"session_id":"s-1","tool_input":{{"command":"cat é"}},"tool_response":{{"stdout":"{output}"}}}}"#
    );
    let kept = said(payload.as_bytes());
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(kept.as_str().unwrap()).unwrap(),
        serde_json::json!({ "session_id": "s-1", "tool_input": { "command": "cat \u{e9}" } })
    );
    // A payload cut short is not an object this reads.
    let cut = r#"{"session_id":"s-2","tool_response":"y"#;
    assert_eq!(said(cut.as_bytes()), serde_json::Value::String(cut.into()));
}

/// With no host to reach, a hook prints nothing and succeeds, so the agent goes on.
#[cfg(unix)]
#[test]
fn a_hook_with_no_door_prints_nothing_and_succeeds() {
    let out = Command::new(BIN)
        .args(["hook", temp().join("none.sock").to_str().unwrap()])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(out.status.success());
    assert!(out.stdout.is_empty());
}
