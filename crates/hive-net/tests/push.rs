// The push role (design §12.4, spec/push.md 0.3), through its HTTP interface as a phone and the
// person's devices use it: a phone registers, naming the devices that may tell it, and what one of
// them signs for it is passed on to the phone's distributor as it came, once, with the server's
// VAPID token; what any other device posts, unsigned, signed for another phone or changed, is not,
// nor anything that is not a Web Push message. A phone registers anew under the same handle; the
// same registration again, an older one, one it did not sign, or one whose time is far from the
// server's is refused. A server tells no phone at an address on its own networks unless it is
// allowed to, nor at a name looked up to one, and reaches one on the internet over https alone. A
// phone its distributor no longer knows is told there no more, and a failure says nothing of
// where. A phone is passed so many notices, and an address may make so many requests. Beside the
// access role, only a phone on the network registers. The network's profile says where its push
// server is, how it tells phones and its VAPID key. A service that speaks HTTP/2 alone, as Apple's
// does, is reached.

mod support;

use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    path::Path,
    sync::{
        atomic::{AtomicU16, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Instant,
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hive_net::signed::now_ms;
use iroh::SecretKey;
use ring::signature::{UnparsedPublicKey, ECDSA_P256_SHA256_FIXED};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use support::*;

/// A post a distributor was given: where, its headers (names in lowercase), and its body.
#[derive(Debug, Clone)]
struct Posted {
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Posted {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
}

/// A UnifiedPush distributor of the test's, on this machine: its address for one phone, what it
/// was posted, and the status it answers with.
struct Distributor {
    url: String,
    posted: Arc<Mutex<Vec<Posted>>>,
    answers: Arc<AtomicU16>,
    /// Where it sends a post on, answering 307.
    moved: Arc<Mutex<String>>,
}

impl Distributor {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/up/a-phone", listener.local_addr().unwrap());
        let posted = Arc::new(Mutex::new(vec![]));
        let answers = Arc::new(AtomicU16::new(201));
        let moved = Arc::new(Mutex::new(String::new()));
        let (keep, answer, elsewhere) = (posted.clone(), answers.clone(), moved.clone());
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                let path = line.split(' ').nth(1).unwrap_or("").to_string();
                let mut headers = vec![];
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    let header = header.trim_end();
                    if header.is_empty() {
                        break;
                    }
                    if let Some((name, value)) = header.split_once(':') {
                        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
                    }
                }
                let length = headers
                    .iter()
                    .find(|(n, _)| n == "content-length")
                    .and_then(|(_, v)| v.parse().ok())
                    .unwrap_or(0);
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                keep.lock().unwrap().push(Posted {
                    path,
                    headers,
                    body,
                });
                let status = answer.load(Ordering::SeqCst);
                let location = elsewhere.lock().unwrap().clone();
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} Answered\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
            }
        });
        Self {
            url,
            posted,
            answers,
            moved,
        }
    }

    fn posted(&self) -> Vec<Posted> {
        self.posted.lock().unwrap().clone()
    }
}

fn key() -> SecretKey {
    SecretKey::from_bytes(&rand::random::<[u8; 32]>())
}

/// The network of this machine's own the role may tell phones at, in these tests.
const LOOPBACK: [&str; 2] = ["--push-allow", "127.0.0.0/8"];

/// `serve --push` keeping its state in `root`, with `args`: it and its URL.
fn serve(root: &Path, args: &[&str]) -> (Running, String) {
    let data = root.join("server");
    let mut all = vec![
        "serve",
        "--push",
        "--data",
        data.to_str().unwrap(),
        "--bind",
        "127.0.0.1:0",
    ];
    all.extend_from_slice(args);
    let running = start(&all, &[]);
    let url = running.after("push serving on ");
    (running, url)
}

/// A registration as the phone of `phone` signs it (spec/push.md 0.3, "Registering").
fn registration(
    phone: &SecretKey,
    token: &str,
    senders: &[&SecretKey],
    at: u64,
    signer: &SecretKey,
) -> String {
    let device = phone.public().to_string();
    let senders: Vec<String> = senders.iter().map(|k| k.public().to_string()).collect();
    let signed = format!(
        "hive/push-register/1\n{device}\nunifiedpush\n{token}\n0\n{}\n{at}",
        senders.join(",")
    );
    let signature = hex::encode(signer.sign(signed.as_bytes()).to_bytes());
    json!({
        "v": 1, "device": device, "platform": "unifiedpush", "token": token, "sandbox": false,
        "senders": senders, "at": at, "signature": signature,
    })
    .to_string()
}

/// Register at the push role `push`: the status, and what it answered.
fn register(push: &str, body: &str) -> (u16, Value) {
    let (status, answer) = http(
        "POST",
        &format!("{push}/register"),
        &[("Content-Type", "application/json")],
        body.as_bytes(),
    );
    (
        status,
        serde_json::from_slice(&answer).unwrap_or(Value::Null),
    )
}

fn handle_of(push: &str, body: &str) -> String {
    let (status, answer) = register(push, body);
    assert_eq!(status, 200, "{answer}");
    let handle = answer["handle"].as_str().unwrap().to_string();
    assert!(
        handle.len() == 32 && handle.bytes().all(|b| b.is_ascii_hexdigit()),
        "{handle}"
    );
    handle
}

/// `Hive-Sender` for `body` posted to the phone of `handle` by `device` at `at`.
fn sender(device: &SecretKey, handle: &str, at: u64, body: &[u8]) -> String {
    let mut signed = format!("hive/push-notice/1\n{handle}\n{at}\n").into_bytes();
    signed.extend(Sha256::digest(body));
    format!(
        "{} {at} {}",
        device.public(),
        hex::encode(device.sign(&signed).to_bytes())
    )
}

/// Post `body` to `endpoint` with `headers`: the status and what it answered.
fn post_with(endpoint: &str, body: &[u8], headers: &[(&str, &str)]) -> (u16, Value) {
    let (status, answer) = http("POST", endpoint, headers, body);
    (
        status,
        serde_json::from_slice(&answer).unwrap_or(Value::Null),
    )
}

/// Post `body` to `endpoint` as a device does, with `Hive-Sender: signed` when there is one.
fn post(endpoint: &str, body: &[u8], signed: Option<&str>) -> u16 {
    let mut headers = vec![
        ("TTL", "86400"),
        ("Urgency", "high"),
        ("Content-Encoding", "aes128gcm"),
        ("Content-Type", "application/octet-stream"),
    ];
    if let Some(signed) = signed {
        headers.push(("Hive-Sender", signed));
    }
    post_with(endpoint, body, &headers).0
}

/// Post `body` to the phone at `endpoint` (`…/<handle>`), signed by `device` now.
fn post_signed(endpoint: &str, body: &[u8], device: &SecretKey) -> u16 {
    let handle = endpoint.rsplit('/').next().unwrap();
    post(
        endpoint,
        body,
        Some(&sender(device, handle, now_ms(), body)),
    )
}

/// A notice's body as Web Push has it (a salt, the record size, the sender's key, one record),
/// though not one a phone decrypts: the role never reads it.
fn notice(n: u32) -> Vec<u8> {
    let mut body = rand::random::<[u8; 16]>().to_vec();
    body.extend(4096u32.to_be_bytes());
    body.push(65);
    body.push(0x04);
    body.extend(rand::random::<[u8; 32]>());
    body.extend(rand::random::<[u8; 32]>());
    body.extend(format!("ciphertext {n} {:08x}", rand::random::<u32>()).as_bytes());
    body
}

#[test]
fn a_phone_is_told_at_its_distributor_what_the_devices_it_named_sign_for_it_and_nothing_else() {
    let root = temp("push-told");
    let distributor = Distributor::start();
    let (_server, push) = serve(&root, &LOOPBACK);
    let (phone, laptop, stranger) = (key(), key(), key());
    let handle = handle_of(
        &push,
        &registration(&phone, &distributor.url, &[&laptop], now_ms(), &phone),
    );
    let endpoint = format!("{push}/{handle}");

    // The laptop's notice: passed on as it came, with what the laptop said of it, and a VAPID
    // token for the distributor's origin by the server's key.
    let first = notice(1);
    let signed = sender(&laptop, &handle, now_ms(), &first);
    assert_eq!(post(&endpoint, &first, Some(&signed)), 201);
    let posted = distributor.posted();
    assert_eq!(posted.len(), 1);
    assert_eq!(posted[0].path, "/up/a-phone");
    assert_eq!(posted[0].body, first);
    assert_eq!(posted[0].header("ttl"), Some("86400"));
    assert_eq!(posted[0].header("urgency"), Some("high"));
    assert_eq!(posted[0].header("content-encoding"), Some("aes128gcm"));
    assert_eq!(
        posted[0].header("content-type"),
        Some("application/octet-stream")
    );
    assert_eq!(
        posted[0].header("hive-sender"),
        None,
        "the device's signature went on"
    );
    let vapid = posted[0].header("authorization").unwrap();
    let (token, k) = vapid
        .strip_prefix("vapid t=")
        .and_then(|v| v.split_once(", k="))
        .unwrap();
    let parts: Vec<&str> = token.split('.').collect();
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
    assert_eq!(
        claims["aud"],
        distributor.url.trim_end_matches("/up/a-phone")
    );
    let exp = claims["exp"].as_u64().unwrap();
    assert!(
        exp > now_ms() / 1000 && exp <= now_ms() / 1000 + 24 * 3600,
        "{claims}"
    );
    UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, URL_SAFE_NO_PAD.decode(k).unwrap())
        .verify(
            format!("{}.{}", parts[0], parts[1]).as_bytes(),
            &URL_SAFE_NO_PAD.decode(parts[2]).unwrap(),
        )
        .expect("the VAPID token is signed by the key it gives");

    // The same post again: not passed on twice.
    assert_eq!(post(&endpoint, &first, Some(&signed)), 409);
    // A device the phone did not name, and a handle no phone has: answered alike.
    let second = notice(2);
    assert_eq!(post_signed(&endpoint, &second, &stranger), 404);
    let nobody = format!("{push}/{}", hex::encode(rand::random::<[u8; 16]>()));
    assert_eq!(post_signed(&nobody, &second, &laptop), 404);
    // Unsigned; signed for another body, or for another phone; signed long ago.
    assert_eq!(post(&endpoint, &second, None), 401);
    assert_eq!(post(&endpoint, &second, Some(&signed)), 401);
    let elsewhere = sender(&laptop, &"0".repeat(32), now_ms(), &second);
    assert_eq!(post(&endpoint, &second, Some(&elsewhere)), 401);
    let old = sender(&laptop, &handle, now_ms() - 11 * 60 * 1000, &second);
    assert_eq!(post(&endpoint, &second, Some(&old)), 401);
    // Not a Web Push message; one that says not how long it may wait; one larger than one is.
    assert_eq!(
        post_signed(&endpoint, br#"{"post":"this anywhere"}"#, &laptop),
        400
    );
    let untimed = sender(&laptop, &handle, now_ms(), &second);
    assert_eq!(
        post_with(&endpoint, &second, &[("Hive-Sender", untimed.as_str())]).0,
        400
    );
    let mut large = notice(3);
    large.resize(4097, 0);
    assert_eq!(post_signed(&endpoint, &large, &laptop), 413);
    assert_eq!(distributor.posted().len(), 1);

    // What the role keeps: the registration alone, readable by its user alone, nothing posted.
    let kept = root.join("server").join("push.json");
    let text = fs::read_to_string(&kept).unwrap();
    assert!(text.contains(&phone.public().to_string()) && text.contains(&distributor.url));
    assert!(!text.contains("ciphertext"), "a notice was kept: {text}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&kept).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn a_phone_registers_anew_under_its_handle_naming_the_devices_it_names_now_and_the_same_an_older_or_an_unproven_registration_is_refused(
) {
    let root = temp("push-again");
    let distributor = Distributor::start();
    let (_server, push) = serve(&root, &LOOPBACK);
    let (phone, laptop, host) = (key(), key(), key());
    let at = now_ms();
    let first = registration(&phone, &distributor.url, &[&laptop], at, &phone);
    let handle = handle_of(&push, &first);

    // Again, the host named in the laptop's place: the same handle, and the laptop is no sender.
    let again = registration(&phone, &distributor.url, &[&host], at + 1, &phone);
    assert_eq!(handle_of(&push, &again), handle);
    let endpoint = format!("{push}/{handle}");
    assert_eq!(post_signed(&endpoint, &notice(1), &laptop), 404);
    assert_eq!(post_signed(&endpoint, &notice(2), &host), 201);

    // The kept registration once more, and the first: neither is later, so the laptop stays out.
    assert_eq!(register(&push, &again).0, 403);
    assert_eq!(register(&push, &first).0, 403);
    assert_eq!(post_signed(&endpoint, &notice(3), &laptop), 404);
    // Signed by another key than the phone's; of a version not read.
    let (status, answer) = register(
        &push,
        &registration(&phone, &distributor.url, &[&laptop], now_ms(), &laptop),
    );
    assert_eq!(status, 403, "{answer}");
    let mut v2: Value = serde_json::from_str(&registration(
        &phone,
        &distributor.url,
        &[&laptop],
        now_ms(),
        &phone,
    ))
    .unwrap();
    v2["v"] = json!(2);
    assert_eq!(register(&push, &v2.to_string()).0, 403);
    assert_eq!(post_signed(&endpoint, &notice(4), &laptop), 404);

    // A phone new here, its registration signed long ago, or for a time to come: refused.
    let other = key();
    for when in [now_ms() - 11 * 60 * 1000, now_ms() + 11 * 60 * 1000] {
        let (status, answer) = register(
            &push,
            &registration(&other, &distributor.url, &[&laptop], when, &other),
        );
        assert_eq!(status, 403, "{answer}");
    }
    // Registered now: a handle of its own.
    let theirs = handle_of(
        &push,
        &registration(&other, &distributor.url, &[&laptop], now_ms(), &other),
    );
    assert_ne!(theirs, handle);
}

#[test]
fn a_phone_is_told_on_the_server_s_own_networks_only_where_it_is_allowed_to_and_on_the_internet_over_https(
) {
    let (phone, laptop) = (key(), key());
    let at = now_ms();
    let try_each = |push: &str, tokens: &[&str], status: u16| {
        for (i, token) in tokens.iter().enumerate() {
            let body = registration(&phone, token, &[&laptop], at + i as u64, &phone);
            let (answered, answer) = register(push, &body);
            assert_eq!(answered, status, "{token}: {answer}");
        }
    };
    // Serving no network of its own: the internet alone, over https.
    let (_server, push) = serve(&temp("push-public"), &[]);
    try_each(
        &push,
        &[
            "http://127.0.0.1:9/up",
            "https://localhost:9/up",
            "https://[::1]:9/up",
            "https://10.1.2.3/up",
            "https://169.254.169.254/latest/meta-data",
            "http://ntfy.example.org/up",
            "http://93.184.215.14/up",
        ],
        403,
    );
    try_each(&push, &["https://ntfy.example.org/up/1"], 200);
    // Serving 10.1.0.0/16 too: there, over http too, and a name may be there; nowhere else of its
    // own.
    let (_server, push) = serve(&temp("push-allowed"), &["--push-allow", "10.1.0.0/16"]);
    try_each(
        &push,
        &[
            "https://10.2.0.5/up",
            "https://127.0.0.1:9/up",
            "https://169.254.169.254/latest/meta-data",
            "http://93.184.215.14/up",
        ],
        403,
    );
    try_each(
        &push,
        &[
            "http://10.1.2.3:8080/up",
            "https://10.1.2.3/up",
            "http://ntfy.lan/up",
            "https://ntfy.example.org/up/2",
        ],
        200,
    );

    // A phone registered while the server served this machine's network, after it no longer does:
    // its notices go nowhere.
    let root = temp("push-was-allowed");
    let distributor = Distributor::start();
    let (server, push) = serve(&root, &LOOPBACK);
    let handle = handle_of(
        &push,
        &registration(&phone, &distributor.url, &[&laptop], now_ms(), &phone),
    );
    drop(server);
    let (_server, push) = serve(&root, &[]);
    assert_eq!(
        post_signed(&format!("{push}/{handle}"), &notice(1), &laptop),
        502
    );
    assert!(distributor.posted().is_empty());
}

#[test]
fn a_server_whose_registrations_cannot_be_read_does_not_start_without_them() {
    let root = temp("push-unread");
    // Something there, and not a file: no state of the role's, nor none.
    fs::create_dir_all(root.join("server").join("push.json")).unwrap();
    let data = root.join("server");
    let out = hive_net(
        &[
            "serve",
            "--push",
            "--data",
            data.to_str().unwrap(),
            "--bind",
            "127.0.0.1:0",
        ],
        &[],
    );
    assert!(!out.status.success(), "{}", text(&out));
    assert!(text(&out).contains("push.json"), "{}", text(&out));
}

#[test]
fn a_phone_its_distributor_no_longer_knows_is_told_here_no_more_and_one_whose_distributor_failed_stays_and_is_not_told_where(
) {
    let root = temp("push-gone");
    let distributor = Distributor::start();
    let (_server, push) = serve(&root, &LOOPBACK);
    let (phone, laptop) = (key(), key());
    let handle = handle_of(
        &push,
        &registration(&phone, &distributor.url, &[&laptop], now_ms(), &phone),
    );
    let endpoint = format!("{push}/{handle}");
    let send = |n| {
        let body = notice(n);
        let signed = sender(&laptop, &handle, now_ms(), &body);
        post_with(
            &endpoint,
            &body,
            &[("TTL", "60"), ("Hive-Sender", signed.as_str())],
        )
    };

    // A distributor failing is tried once more, and the phone stays registered; what the device
    // is answered names no address.
    distributor.answers.store(500, Ordering::SeqCst);
    let (status, answer) = send(1);
    assert_eq!(status, 502);
    assert!(!answer.to_string().contains("127.0.0.1"), "{answer}");
    assert_eq!(distributor.posted().len(), 2);
    assert_eq!(
        send(2).0,
        502,
        "a phone whose distributor failed was dropped"
    );

    // Too large for it: said so, and the phone stays registered.
    distributor.answers.store(413, Ordering::SeqCst);
    assert_eq!(send(3).0, 413);
    assert_eq!(distributor.posted().len(), 5);
    // Sent elsewhere: not followed, and nothing is posted there.
    let elsewhere = Distributor::start();
    *distributor.moved.lock().unwrap() = elsewhere.url.clone();
    distributor.answers.store(307, Ordering::SeqCst);
    assert_eq!(send(4).0, 502);
    assert!(elsewhere.posted().is_empty(), "a redirect was followed");

    distributor.answers.store(410, Ordering::SeqCst);
    assert_eq!(send(5).0, 410);
    assert_eq!(distributor.posted().len(), 7);
    let kept = fs::read_to_string(root.join("server").join("push.json")).unwrap();
    assert!(!kept.contains(&phone.public().to_string()), "{kept}");
    assert_eq!(send(6).0, 404);
    assert_eq!(distributor.posted().len(), 7);
}

#[test]
fn a_phone_is_passed_sixty_notices_at_once_then_one_a_second_and_an_address_may_make_six_hundred_requests_at_once(
) {
    let root = temp("push-quota");
    let distributor = Distributor::start();
    let (_server, push) = serve(&root, &LOOPBACK);
    let (phone, laptop) = (key(), key());
    let began = Instant::now();
    let handle = handle_of(
        &push,
        &registration(&phone, &distributor.url, &[&laptop], now_ms(), &phone),
    );
    let endpoint = format!("{push}/{handle}");
    for n in 0..60 {
        assert_eq!(
            post_signed(&endpoint, &notice(n), &laptop),
            201,
            "notice {n}"
        );
    }
    // Then one a second: at most one more for each second gone.
    let mut passed = 60;
    let held = (60..80).any(|n| match post_signed(&endpoint, &notice(n), &laptop) {
        201 => {
            passed += 1;
            false
        }
        status => status == 429,
    });
    let seconds = began.elapsed().as_secs();
    assert!(held, "no notice was held back");
    assert!(
        passed <= 60 + seconds + 1,
        "{passed} notices passed in {seconds} s"
    );

    // From this address, 600 requests at once, then ten a second.
    let began = Instant::now();
    let made = 1 + passed + 1;
    let mut answered = 0;
    while register(&push, "{}").0 != 429 {
        answered += 1;
        assert!(answered < 2_000, "no request was held back");
    }
    let seconds = began.elapsed().as_secs() + 1;
    assert!(
        made + answered >= 600 && made + answered <= 600 + 10 * seconds + 10,
        "{answered} more answered in {seconds} s"
    );
}

#[test]
fn beside_the_access_role_a_phone_registers_once_it_is_on_the_network() {
    let root = temp("push-admitted");
    let distributor = Distributor::start();
    let admin_key = root.join("admin.key");
    fs::write(&admin_key, format!("{}\n", "a1".repeat(32))).unwrap();
    let admin = SecretKey::from_bytes(&[0xa1; 32]).public().to_string();
    let data = root.join("server");
    let server = start(
        &[
            "serve",
            "--access",
            "--push",
            LOOPBACK[0],
            LOOPBACK[1],
            "--admin-id",
            &admin,
            "--data",
            data.to_str().unwrap(),
            "--bind",
            "127.0.0.1:0",
        ],
        &[],
    );
    let access = server.after("access serving on ");
    let push = server.after("push serving on ");
    let (phone, laptop) = (key(), key());
    let (status, answer) = register(
        &push,
        &registration(&phone, &distributor.url, &[&laptop], now_ms(), &phone),
    );
    assert_eq!(status, 403, "{answer}");
    assert!(
        answer["error"]
            .as_str()
            .unwrap()
            .contains("not on the network"),
        "{answer}"
    );

    let voucher = hive_net(
        &[
            "access",
            "voucher",
            "--kind",
            "enrol",
            "--device",
            &phone.public().to_string(),
            "--admin",
            admin_key.to_str().unwrap(),
        ],
        &[],
    );
    assert!(voucher.status.success(), "{}", text(&voucher));
    let voucher = String::from_utf8(voucher.stdout).unwrap();
    let vouched = hive_net(&["access", "vouch", &access, voucher.trim()], &[]);
    assert!(vouched.status.success(), "{}", text(&vouched));
    handle_of(
        &push,
        &registration(&phone, &distributor.url, &[&laptop], now_ms(), &phone),
    );
}

/// The network's profile as `serve` signed and kept it.
fn kept_profile(data: &Path) -> Value {
    let signed: Value =
        serde_json::from_str(&fs::read_to_string(data.join("network.json")).unwrap()).unwrap();
    serde_json::from_str(signed["profile"].as_str().unwrap()).unwrap()
}

#[test]
fn the_network_s_profile_says_where_its_push_server_is_how_it_tells_phones_and_its_vapid_key() {
    let root = temp("push-profile");
    let data = root.join("server");
    let port = free_port();
    let base = format!("http://127.0.0.1:{port}");
    let bind = format!("127.0.0.1:{port}");
    let serve_with = |more: &[&str]| {
        let mut args = vec![
            "serve",
            "--access",
            "--push",
            "--url",
            &base,
            "--bind",
            &bind,
            "--data",
            data.to_str().unwrap(),
        ];
        args.extend_from_slice(more);
        let running = start(&args, &[]);
        running.after("network link: ");
        running
    };
    let running = serve_with(&[]);
    let push = kept_profile(&data)["push"].clone();
    assert_eq!(push["url"], format!("{base}/push"));
    assert_eq!(push["kinds"], json!(["unifiedpush"]));
    let vapid = URL_SAFE_NO_PAD
        .decode(push["vapid"].as_str().unwrap())
        .unwrap();
    assert!(vapid.len() == 65 && vapid[0] == 4, "{push}");
    drop(running);

    // With Apple's credentials, phones are told through Apple's service too; the key the same.
    let rng = ring::rand::SystemRandom::new();
    let p8 = ring::signature::EcdsaKeyPair::generate_pkcs8(
        &ring::signature::ECDSA_P256_SHA256_FIXED_SIGNING,
        &rng,
    )
    .unwrap();
    let p8_file = root.join("AuthKey_KEY1234567.p8");
    fs::write(
        &p8_file,
        format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            base64::engine::general_purpose::STANDARD.encode(p8.as_ref())
        ),
    )
    .unwrap();
    let apple = [
        "--apns-key",
        p8_file.to_str().unwrap(),
        "--apns-key-id",
        "KEY1234567",
        "--apns-team",
        "TEAM123456",
        "--apns-topic",
        "com.example.hive",
    ];
    let running = serve_with(&apple);
    let again = kept_profile(&data)["push"].clone();
    assert_eq!(again["kinds"], json!(["apns", "unifiedpush"]));
    assert_eq!(again["vapid"], push["vapid"]);
    drop(running);

    // Apple's credentials come whole, and a key that is not one is refused.
    let out = hive_net(
        &[
            "serve",
            "--push",
            "--data",
            data.to_str().unwrap(),
            "--bind",
            "127.0.0.1:0",
            "--apns-key",
            p8_file.to_str().unwrap(),
        ],
        &[],
    );
    assert!(!out.status.success());
    assert!(text(&out).contains("go together"), "{}", text(&out));
    fs::write(
        &p8_file,
        "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
    )
    .unwrap();
    let mut args = vec![
        "serve",
        "--push",
        "--data",
        data.to_str().unwrap(),
        "--bind",
        "127.0.0.1:0",
    ];
    args.extend_from_slice(&apple);
    let out = hive_net(&args, &[]);
    assert!(!out.status.success());
    assert!(text(&out).contains("P-256"), "{}", text(&out));
}

/// What a service took: each post's HTTP version and body.
type Took = Arc<Mutex<Vec<(String, Vec<u8>)>>>;

/// A push service on this machine, listening on `ip`, that speaks HTTP/2 alone, as Apple's does,
/// over TLS with a certificate for `name`: its address, the file of the authority that signed the
/// certificate, and what it took.
fn http2_service(root: &Path, ip: &str, name: &str) -> (String, String, Took) {
    use http_body_util::BodyExt;
    let (ca, cert, key) = certificates_for(root, &[name]);
    let cert =
        rustls::pki_types::CertificateDer::from(pem_body(&fs::read_to_string(cert).unwrap()));
    let key =
        rustls::pki_types::PrivateKeyDer::Pkcs8(pem_body(&fs::read_to_string(key).unwrap()).into());
    let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(vec![cert], key)
    .unwrap();
    config.alpn_protocols = vec![b"h2".to_vec()];
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind((ip, 0)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!(
        "https://{name}:{}/up/a-phone",
        listener.local_addr().unwrap().port()
    );
    let took = Arc::new(Mutex::new(vec![]));
    let keep = took.clone();
    thread::spawn(move || {
        tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(async move {
                let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                loop {
                    let (tcp, _) = listener.accept().await.unwrap();
                    let (acceptor, keep) = (acceptor.clone(), keep.clone());
                    tokio::spawn(async move {
                        let Ok(tls) = acceptor.accept(tcp).await else {
                            return;
                        };
                        let service = hyper::service::service_fn(
                            move |req: hyper::Request<hyper::body::Incoming>| {
                                let keep = keep.clone();
                                async move {
                                    let version = format!("{:?}", req.version());
                                    let body = req.into_body().collect().await?.to_bytes().to_vec();
                                    keep.lock().unwrap().push((version, body));
                                    let mut res = hyper::Response::new(http_body_util::Full::new(
                                        bytes::Bytes::new(),
                                    ));
                                    *res.status_mut() = hyper::StatusCode::CREATED;
                                    Ok::<_, hyper::Error>(res)
                                }
                            },
                        );
                        let _ = hyper::server::conn::http2::Builder::new(
                            hyper_util::rt::TokioExecutor::new(),
                        )
                        .serve_connection(hyper_util::rt::TokioIo::new(tls), service)
                        .await;
                    });
                }
            });
    });
    (url, ca, took)
}

/// The DER inside a PEM file.
fn pem_body(pem: &str) -> Vec<u8> {
    let inner: String = pem.lines().filter(|l| !l.starts_with("-----")).collect();
    base64::engine::general_purpose::STANDARD
        .decode(inner)
        .unwrap()
}

#[test]
fn a_notice_reaches_a_service_that_speaks_http2_alone_as_apple_s_does() {
    let root = temp("push-h2");
    let (url, ca, took) = http2_service(&root, "127.0.0.1", "127.0.0.1");
    let data = root.join("server");
    let server = start(
        &[
            "serve",
            "--push",
            LOOPBACK[0],
            LOOPBACK[1],
            "--data",
            data.to_str().unwrap(),
            "--bind",
            "127.0.0.1:0",
        ],
        &[("SSL_CERT_FILE", ca.as_str())],
    );
    let push = server.after("push serving on ");
    let (phone, laptop) = (key(), key());
    let handle = handle_of(
        &push,
        &registration(&phone, &url, &[&laptop], now_ms(), &phone),
    );
    let body = notice(1);
    assert_eq!(
        post_signed(&format!("{push}/{handle}"), &body, &laptop),
        201
    );
    assert_eq!(*took.lock().unwrap(), vec![("HTTP/2.0".to_string(), body)]);
}

#[test]
fn a_distributor_whose_name_is_looked_up_to_an_address_on_the_server_s_own_networks_is_not_posted_to(
) {
    // This machine's name, looked up as anyone's: one of its own addresses, nearly everywhere.
    let name = std::process::Command::new("hostname")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let own: Vec<std::net::IpAddr> = std::net::ToSocketAddrs::to_socket_addrs(&(name.as_str(), 0))
        .map(|found| found.map(|a| a.ip()).collect())
        .unwrap_or_default();
    let local = |ip: &std::net::IpAddr| match ip {
        std::net::IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
        std::net::IpAddr::V6(v6) => v6.is_loopback(),
    };
    if name.is_empty() || own.is_empty() || !own.iter().all(local) {
        eprintln!("{name:?} is not looked up to this machine's own addresses here: nothing to try");
        return;
    }
    // A distributor there that would take the post, its certificate trusted.
    let root = temp("push-named");
    let (url, ca, took) = http2_service(&root, "0.0.0.0", &name);
    let data = root.join("server");
    let server = start(
        &[
            "serve",
            "--push",
            "--data",
            data.to_str().unwrap(),
            "--bind",
            "127.0.0.1:0",
        ],
        &[("SSL_CERT_FILE", ca.as_str())],
    );
    let push = server.after("push serving on ");
    let (phone, laptop) = (key(), key());
    let handle = handle_of(
        &push,
        &registration(&phone, &url, &[&laptop], now_ms(), &phone),
    );
    assert_eq!(
        post_signed(&format!("{push}/{handle}"), &notice(1), &laptop),
        502
    );
    assert!(took.lock().unwrap().is_empty(), "posted to {name}");
}
