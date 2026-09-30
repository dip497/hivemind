// Network profiles (R16, spec/network-profile.md): a profile signed by the admin it names is used,
// and any other is not (conformance/network-profile.json, signed apart from this code, which signs
// the same bytes); the CLI verifies, signs and links them, and a device reaches another through a
// relay only a profile names; an update to a network must come from its admin.

use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
};

use hive_net::profile::{self, Signed};
use iroh::SecretKey;
use serde_json::Value;

const BIN: &str = env!("CARGO_BIN_EXE_hive-net");

fn cases() -> Value {
    let file = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../conformance/network-profile.json"
    );
    serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap()
}

fn signed(v: &Value) -> Signed {
    serde_json::from_value(v.clone()).unwrap()
}

fn seed(hex_seed: &str) -> SecretKey {
    let mut bytes = [0u8; 32];
    hex::decode_to_slice(hex_seed, &mut bytes).unwrap();
    SecretKey::from_bytes(&bytes)
}

fn hive_net(args: &[&str]) -> Output {
    Command::new(BIN).args(args).output().unwrap()
}

fn text(out: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

/// The public key of the seed kept in `file`.
fn profile_admin_id(file: &std::path::Path) -> String {
    seed(fs::read_to_string(file).unwrap().trim())
        .public()
        .to_string()
}

fn temp() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "hive-net-profile-{}-{:08x}",
        std::process::id(),
        rand::random::<u32>()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn a_profile_signed_by_the_admin_it_names_is_used_and_no_other() {
    let cases = cases();
    let admin = cases["admin"].as_str().unwrap();
    for case in cases["valid"].as_array().unwrap() {
        let file = signed(&case["file"]);
        let verified = profile::verify(&file).unwrap_or_else(|e| panic!("{}: {e:#}", case["why"]));
        assert_eq!(verified.admin.unwrap().to_string(), admin);
        assert_eq!(verified.profile.name, "Example Corp");
        // The link carries the same file; and this code signs the same bytes to the same signature.
        let link = case["link"].as_str().unwrap();
        assert_eq!(profile::link(&file), link);
        assert_eq!(profile::load(link).unwrap(), verified);
        let made =
            profile::sign(&file.profile, &seed(cases["adminSeed"].as_str().unwrap())).unwrap();
        assert_eq!(made.signature, file.signature);
    }
    for case in cases["invalid"].as_array().unwrap() {
        assert!(
            profile::verify(&signed(&case["file"])).is_err(),
            "used although {}",
            case["why"]
        );
    }
}

#[test]
fn the_cli_verifies_signs_and_links_profiles_and_the_built_in_ones_need_no_signature() {
    let out = hive_net(&["profile", "verify", "local"]);
    assert!(out.status.success(), "{}", text(&out));
    let local: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(local["builtin"], "local");
    assert_eq!(local["profile"]["relays"], serde_json::json!([]));

    let dir = temp();
    let cases = cases();
    let admin_key = dir.join("admin.key");
    fs::write(
        &admin_key,
        format!("{}\n", cases["adminSeed"].as_str().unwrap()),
    )
    .unwrap();
    let text_file = dir.join("profile.json");
    fs::write(
        &text_file,
        cases["valid"][0]["file"]["profile"].as_str().unwrap(),
    )
    .unwrap();
    let out = hive_net(&[
        "profile",
        "sign",
        text_file.to_str().unwrap(),
        "--admin",
        admin_key.to_str().unwrap(),
    ]);
    assert!(out.status.success(), "{}", text(&out));
    let signed_file = dir.join("signed.json");
    fs::write(&signed_file, &out.stdout).unwrap();
    let out = hive_net(&["profile", "link", signed_file.to_str().unwrap()]);
    assert!(out.status.success(), "{}", text(&out));
    let link = String::from_utf8(out.stdout).unwrap();
    assert_eq!(link.trim(), cases["valid"][0]["link"].as_str().unwrap());
    let out = hive_net(&["profile", "verify", link.trim()]);
    assert!(out.status.success(), "{}", text(&out));
    let verified: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(verified["admin"], cases["admin"]);

    // Changed after it was signed: refused, and said why.
    let mut tampered: Value = serde_json::from_slice(&fs::read(&signed_file).unwrap()).unwrap();
    tampered["profile"] = Value::String(
        tampered["profile"]
            .as_str()
            .unwrap()
            .replace("Corp", "Crop"),
    );
    fs::write(&signed_file, tampered.to_string()).unwrap();
    let out = hive_net(&["profile", "verify", signed_file.to_str().unwrap()]);
    assert!(!out.status.success());
    assert!(
        text(&out).contains("not signed by its admin"),
        "{}",
        text(&out)
    );
    // In place of the network in use, an update from another admin is refused.
    let stranger = dir.join("stranger.key");
    fs::write(&stranger, format!("{}\n", "55".repeat(32))).unwrap();
    let theirs =
        serde_json::json!({ "v": 1, "name": "Example Corp", "admin": profile_admin_id(&stranger) })
            .to_string();
    let theirs_file = dir.join("theirs.json");
    fs::write(&theirs_file, &theirs).unwrap();
    let out = hive_net(&[
        "profile",
        "sign",
        theirs_file.to_str().unwrap(),
        "--admin",
        stranger.to_str().unwrap(),
    ]);
    let theirs_signed = dir.join("theirs-signed.json");
    fs::write(&theirs_signed, &out.stdout).unwrap();
    let mine = dir.join("mine.json");
    fs::write(
        &mine,
        serde_json::to_string(&cases["valid"][0]["file"]).unwrap(),
    )
    .unwrap();
    let out = hive_net(&[
        "profile",
        "verify",
        theirs_signed.to_str().unwrap(),
        "--replacing",
        mine.to_str().unwrap(),
    ]);
    assert!(!out.status.success(), "{}", text(&out));
    assert!(
        text(&out).contains("not signed by its admin"),
        "{}",
        text(&out)
    );
    assert!(hive_net(&[
        "profile",
        "verify",
        "local",
        "--replacing",
        mine.to_str().unwrap()
    ])
    .status
    .success());
    // A key the profile does not name as its admin cannot sign it.
    let other = dir.join("other.key");
    fs::write(&other, format!("{}\n", "11".repeat(32))).unwrap();
    let out = hive_net(&[
        "profile",
        "sign",
        text_file.to_str().unwrap(),
        "--admin",
        other.to_str().unwrap(),
    ]);
    assert!(!out.status.success());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn an_update_to_a_network_must_be_signed_by_its_admin() {
    let admin = seed(&"22".repeat(32));
    let stranger = seed(&"33".repeat(32));
    let make = |name: &str, key: &SecretKey| {
        let text = serde_json::json!({ "v": 1, "name": name, "admin": key.public().to_string() })
            .to_string();
        profile::verify(&profile::sign(&text, key).unwrap()).unwrap()
    };
    let home = make("Example Corp", &admin);
    assert!(profile::same_admin(&home, &make("Example Corp", &admin)).is_ok());
    assert!(profile::same_admin(&home, &make("Example Corp", &stranger)).is_err());
    // Another network, or a built-in one, is the person's to choose.
    assert!(profile::same_admin(&home, &make("Elsewhere", &stranger)).is_ok());
    assert!(profile::same_admin(&home, &profile::builtin("local").unwrap()).is_ok());
}

#[test]
fn a_device_is_reached_through_a_relay_only_its_profile_names() {
    use std::{
        io::{BufRead, BufReader},
        process::Stdio,
        sync::mpsc,
        thread,
        time::Duration,
    };
    struct Running(std::process::Child);
    impl Drop for Running {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let start = |args: &[&str]| {
        let mut child = Command::new(BIN)
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
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
            .expect("it printed something");
        (Running(child), first)
    };
    let dir = temp();
    let (_relay, serving) = start(&["serve", "--relay", "--bind", "127.0.0.1:0"]);
    let url = serving
        .strip_prefix("relay serving on ")
        .unwrap()
        .to_string();
    // A network whose only way through is that relay: no mDNS, so nothing is found nearby.
    let admin = seed(&"44".repeat(32));
    let body = serde_json::json!({
        "v": 1, "name": "Test network", "relays": [{ "url": url }],
        "admin": admin.public().to_string(), "local": { "mdns": false },
    })
    .to_string();
    let file = dir.join("network.json");
    fs::write(
        &file,
        serde_json::to_string(&profile::sign(&body, &admin).unwrap()).unwrap(),
    )
    .unwrap();
    let ids: Vec<PathBuf> = ["a", "b"]
        .iter()
        .map(|n| {
            let d = dir.join(n);
            fs::create_dir_all(&d).unwrap();
            fs::write(
                d.join("device.key"),
                format!("{}\n", hex::encode(rand::random::<[u8; 32]>())),
            )
            .unwrap();
            d
        })
        .collect();
    let (_a, id) = start(&[
        "run",
        "--identity",
        ids[0].to_str().unwrap(),
        "--profile",
        file.to_str().unwrap(),
    ]);
    let out = hive_net(&[
        "ping",
        &id,
        "--identity",
        ids[1].to_str().unwrap(),
        "--profile",
        file.to_str().unwrap(),
    ]);
    assert!(out.status.success(), "{}", text(&out));
    assert!(text(&out).contains("through a relay"), "{}", text(&out));
    // The doctor says which of a network's relays answer.
    let checked = dir.join("checked.json");
    let body = serde_json::json!({
        "v": 1, "name": "Checked", "admin": admin.public().to_string(),
        "relays": [{ "url": url }, { "url": "http://127.0.0.1:9" }],
    })
    .to_string();
    fs::write(
        &checked,
        serde_json::to_string(&profile::sign(&body, &admin).unwrap()).unwrap(),
    )
    .unwrap();
    let out = hive_net(&[
        "doctor",
        "--identity",
        ids[1].to_str().unwrap(),
        "--profile",
        checked.to_str().unwrap(),
    ]);
    assert!(out.status.success(), "{}", text(&out));
    let report: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let answered: Vec<(String, bool)> = report["relays"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["url"].as_str().unwrap().trim_end_matches('/').to_string(),
                r["ok"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        answered,
        [
            (url.trim_end_matches('/').to_string(), true),
            ("http://127.0.0.1:9".to_string(), false)
        ]
    );
    // On the local network alone, the same device is not found: nothing names that relay.
    let out = hive_net(&[
        "ping",
        &id,
        "--identity",
        ids[1].to_str().unwrap(),
        "--profile",
        "local",
    ]);
    assert!(
        !out.status.success(),
        "found without the relay: {}",
        text(&out)
    );
    fs::remove_dir_all(dir).unwrap();
}
