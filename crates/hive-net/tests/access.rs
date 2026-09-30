// A network's access role (R16, spec/network-access.md), end to end through the command line: on a
// closed network the relay refuses a device nobody enrolled, admits one the admin's voucher
// enrolled, and a voucher used up admits nobody more; an enrolled device vouches for a visitor,
// who is refused once the visit expires; a stranger's voucher counts for nothing; the admin
// revokes; what is allowed outlives a restart. On an open network a device registers with a little
// work, and a registration without it, or not signed by the device, is refused.

use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::mpsc,
    thread,
    time::Duration,
};

use serde_json::Value;

const BIN: &str = env!("CARGO_BIN_EXE_hive-net");

struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A relay with the access role, and where each serves.
fn serve(root: &Path, admin: &str, policy: &str, bits: &str) -> (Running, String, String) {
    let mut child = Command::new(BIN)
        .args([
            "serve",
            "--relay",
            "--access",
            "--admin-id",
            admin,
            "--policy",
            policy,
            "--pow-bits",
            bits,
            "--data",
            root.join("access").to_str().unwrap(),
            "--bind",
            "127.0.0.1:0",
            "--access-bind",
            "127.0.0.1:0",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let running = Running(child);
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if tx.send(line.unwrap_or_default()).is_err() {
                break;
            }
        }
    });
    let line = || {
        rx.recv_timeout(Duration::from_secs(30))
            .expect("serve printed where it serves")
    };
    let relay = line()
        .strip_prefix("relay serving on ")
        .unwrap()
        .to_string();
    let access = line()
        .strip_prefix("access serving on ")
        .unwrap()
        .to_string();
    (running, relay, access)
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

fn temp() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "hive-net-access-{}-{:08x}",
        std::process::id(),
        rand::random::<u32>()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// A device: its identity directory, and its id.
fn device(root: &Path, name: &str) -> (String, String) {
    let dir = root.join(name);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("device.key"),
        format!("{}\n", hex::encode(rand::random::<[u8; 32]>())),
    )
    .unwrap();
    let out = hive_net(&["id", "--identity", dir.to_str().unwrap()]);
    (
        dir.to_str().unwrap().to_string(),
        String::from_utf8(out.stdout).unwrap().trim().to_string(),
    )
}

/// A request to the access service, as a stock relay or anyone would make it: status and body.
fn http(access: &str, method: &str, path: &str, body: Option<&str>) -> (u16, String) {
    let addr = access.trim_start_matches("http://");
    let mut stream = TcpStream::connect(addr).unwrap();
    let body = body.unwrap_or("");
    write!(stream, "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    let status = response[9..12].parse().unwrap();
    let body = response.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    (status, body)
}

fn allowed(access: &str, id: &str) -> bool {
    http(access, "GET", &format!("/allowed/{id}"), None).1 == "true"
}

/// Whether the relay lets the device in, as the device itself finds.
fn relay_admits(relay: &str, identity: &str) -> bool {
    let out = hive_net(&["doctor", "--identity", identity, "--relay", relay]);
    let report: Value =
        serde_json::from_slice(&out.stdout).unwrap_or_else(|_| panic!("{}", text(&out)));
    report["relays"][0]["ok"].as_bool().unwrap()
}

#[test]
fn on_a_closed_network_the_relay_admits_the_devices_enrolled_or_vouched_for_and_no_one_else() {
    let root = temp();
    let admin_key = root.join("admin.key");
    fs::write(&admin_key, format!("{}\n", "a1".repeat(32))).unwrap();
    let (dev, dev_id) = device(&root, "laptop");
    let (guest, guest_id) = device(&root, "guest");
    let (other, other_id) = device(&root, "other");
    let (stranger, _) = device(&root, "stranger");
    // The admin's public key: sign a voucher with it and read `by`.
    let probe: Value = serde_json::from_slice(
        &hive_net(&[
            "access",
            "voucher",
            "--kind",
            "enrol",
            "--admin",
            admin_key.to_str().unwrap(),
        ])
        .stdout,
    )
    .unwrap();
    let admin = probe["by"].as_str().unwrap().to_string();
    let (service, relay, access) = serve(&root, &admin, "closed", "20");

    // Nobody enrolled it: refused.
    assert!(!allowed(&access, &dev_id));
    assert!(
        !relay_admits(&relay, &dev),
        "a device nobody enrolled got in"
    );

    // The admin's enrolment voucher, redeemed by the laptop: in, and the relay lets it in.
    let enrol = String::from_utf8(
        hive_net(&[
            "access",
            "voucher",
            "--kind",
            "enrol",
            "--uses",
            "1",
            "--admin",
            admin_key.to_str().unwrap(),
        ])
        .stdout,
    )
    .unwrap();
    let out = hive_net(&[
        "access",
        "redeem",
        &access,
        enrol.trim(),
        "--identity",
        &dev,
    ]);
    assert!(out.status.success(), "{}", text(&out));
    assert!(allowed(&access, &dev_id));
    assert!(relay_admits(&relay, &dev));
    // Used up: it enrols nobody else.
    let out = hive_net(&[
        "access",
        "redeem",
        &access,
        enrol.trim(),
        "--identity",
        &other,
    ]);
    assert!(!out.status.success());
    assert!(text(&out).contains("used up"), "{}", text(&out));
    assert!(!allowed(&access, &other_id));

    // The laptop, enrolled, vouches for a visitor by their key, for six seconds.
    let visit = String::from_utf8(
        hive_net(&[
            "access",
            "voucher",
            "--kind",
            "visit",
            "--device",
            &guest_id,
            "--expires-in",
            "6",
            "--identity",
            &dev,
        ])
        .stdout,
    )
    .unwrap();
    let out = hive_net(&["access", "vouch", &access, visit.trim()]);
    assert!(out.status.success(), "{}", text(&out));
    assert!(relay_admits(&relay, &guest));
    thread::sleep(Duration::from_millis(6500));
    assert!(!allowed(&access, &guest_id), "a visit outlived its voucher");
    assert!(!relay_admits(&relay, &guest));

    // A stranger's voucher counts for nothing.
    let forged = String::from_utf8(
        hive_net(&[
            "access",
            "voucher",
            "--kind",
            "enrol",
            "--device",
            &other_id,
            "--identity",
            &stranger,
        ])
        .stdout,
    )
    .unwrap();
    let out = hive_net(&["access", "vouch", &access, forged.trim()]);
    assert!(!out.status.success());
    assert!(text(&out).contains("may not vouch"), "{}", text(&out));
    // Nor does one changed after it was signed.
    let mut changed: Value = serde_json::from_str(visit.trim()).unwrap();
    changed["expires"] = Value::from(changed["expires"].as_u64().unwrap() + 3_600_000);
    let (status, _) = http(&access, "POST", "/vouch", Some(&changed.to_string()));
    assert_eq!(status, 403);

    // The admin revokes the laptop; what is allowed outlives a restart.
    let out = hive_net(&[
        "access",
        "revoke",
        &access,
        &dev_id,
        "--admin",
        admin_key.to_str().unwrap(),
    ]);
    assert!(out.status.success(), "{}", text(&out));
    assert!(!allowed(&access, &dev_id));
    let again = String::from_utf8(
        hive_net(&[
            "access",
            "voucher",
            "--kind",
            "enrol",
            "--admin",
            admin_key.to_str().unwrap(),
        ])
        .stdout,
    )
    .unwrap();
    assert!(hive_net(&[
        "access",
        "redeem",
        &access,
        again.trim(),
        "--identity",
        &other
    ])
    .status
    .success());
    drop(service);
    let (_service, _relay, access) = serve(&root, &admin, "closed", "20");
    assert!(allowed(&access, &other_id));
    assert!(!allowed(&access, &dev_id));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn on_an_open_network_a_device_registers_with_a_little_work_and_only_as_itself() {
    let root = temp();
    let (dev, dev_id) = device(&root, "laptop");
    let (_service, relay, access) = serve(&root, &"b2".repeat(32), "open-pow", "16");
    assert!(!relay_admits(&relay, &dev));
    let out = hive_net(&["access", "register", &access, "--identity", &dev]);
    assert!(out.status.success(), "{}", text(&out));
    assert!(allowed(&access, &dev_id));
    assert!(relay_admits(&relay, &dev));

    // Without the work, or not signed by the device, a registration is refused.
    use sha2::{Digest, Sha256};
    let (other, other_id) = device(&root, "other");
    let mut seed = [0u8; 32];
    hex::decode_to_slice(
        fs::read_to_string(Path::new(&other).join("device.key"))
            .unwrap()
            .trim(),
        &mut seed,
    )
    .unwrap();
    let key = iroh::SecretKey::from_bytes(&seed);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let bytes = |n: u64| {
        [
            b"hive/register/1\n".as_slice(),
            key.public().as_bytes(),
            &now.to_be_bytes(),
            &n.to_be_bytes(),
        ]
        .concat()
    };
    let work = |n: u64| {
        let hash = Sha256::digest(bytes(n));
        hash.iter()
            .position(|b| *b != 0)
            .map(|i| i as u32 * 8 + hash[i].leading_zeros())
            .unwrap_or(256)
    };
    let register = |nonce: u64, signer: &iroh::SecretKey| {
        let signature = hex::encode(signer.sign(&bytes(nonce)).to_bytes());
        http(&access, "POST", "/register", Some(&serde_json::json!({ "device": other_id, "at": now, "nonce": nonce, "signature": signature }).to_string()))
    };
    let lazy = (0u64..).find(|n| work(*n) < 16).unwrap();
    let (status, body) = register(lazy, &key);
    assert_eq!(status, 403);
    assert!(body.contains("not enough work"), "{body}");
    let done = (0u64..).find(|n| work(*n) >= 16).unwrap();
    let (status, body) = register(done, &iroh::SecretKey::from_bytes(&[9u8; 32]));
    assert_eq!(status, 403);
    assert!(body.contains("did not prove"), "{body}");
    assert!(!allowed(&access, &other_id));
    // As itself, with the work: in.
    assert_eq!(register(done, &key).0, 200);
    assert!(allowed(&access, &other_id));
    fs::remove_dir_all(root).unwrap();
}
