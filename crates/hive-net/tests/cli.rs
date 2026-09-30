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
            if tx.send(line.unwrap_or_default()).is_err() {
                break;
            }
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
