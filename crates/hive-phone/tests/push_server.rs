//! A phone on a network with a push server (push.rs, spec/push.md 0.3): it registers there to be
//! told by the devices it names, keeping where; registering again, as it does once it unpairs a
//! device, leaves that device out, so what it posts is not passed on. A phone that registered
//! nowhere registers nowhere again. Unpairing the device that let it onto the network, it registers
//! again before that device can take it off; and `hive-phone unpair` says when the push server
//! still lets the device tell it.

mod support;

use std::{net::SocketAddr, path::PathBuf, process::Command};

use hive_net::{
    access,
    egress::Allowed,
    profile::Policy,
    push::{Options as PushOptions, Platform, Service},
    serve::{Options, Serving},
};
use hive_phone::push;
use iroh::SecretKey;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use support::{paired_with, Desk};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
};

fn key() -> SecretKey {
    SecretKey::from_bytes(&rand::random::<[u8; 32]>())
}

fn tmp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "hive-phone-{name}-{}-{:08x}",
        std::process::id(),
        rand::random::<u32>()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A UnifiedPush distributor of the test's, taking every post: its address.
async fn distributor() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/up/a-phone", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stream);
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).await.unwrap();
                    if line.trim().is_empty() {
                        break;
                    }
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = v.trim().parse().unwrap();
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).await.unwrap();
                let _ = reader
                    .into_inner()
                    .write_all(
                        b"HTTP/1.1 201 Created\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await;
            });
        }
    });
    url
}

/// Post a notice to `endpoint` as `device` signs it (spec/push.md 0.3): the status answered.
async fn post(endpoint: &str, device: &SecretKey) -> u16 {
    // A Web Push message's shape: a salt, the record size, the sender's key, one record.
    let mut body = rand::random::<[u8; 16]>().to_vec();
    body.extend(4096u32.to_be_bytes());
    body.push(65);
    body.push(0x04);
    body.extend(rand::random::<[u8; 32]>());
    body.extend(rand::random::<[u8; 32]>());
    body.extend(format!("ciphertext {:08x}", rand::random::<u32>()).as_bytes());
    let at = hive_net::signed::now_ms();
    let handle = endpoint.rsplit('/').next().unwrap();
    let mut signed = format!("hive/push-notice/1\n{handle}\n{at}\n").into_bytes();
    signed.extend(Sha256::digest(&body));
    let sender = format!(
        "{} {at} {}",
        device.public(),
        hex::encode(device.sign(&signed).to_bytes())
    );
    let (addr, path) = endpoint
        .trim_start_matches("http://")
        .split_once('/')
        .unwrap();
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let head = format!(
        "POST /{path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nTTL: 60\r\nContent-Encoding: aes128gcm\r\nHive-Sender: {sender}\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(&body).await.unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).await.unwrap();
    answer[9..12].parse().unwrap()
}

#[tokio::test]
async fn a_phone_registers_again_without_the_device_it_unpaired_and_what_that_device_posts_is_not_passed_on(
) {
    let server_dir = tmp("push-server");
    let serving = Serving::spawn(Options {
        bind: "127.0.0.1:0".parse().unwrap(),
        certificate: None,
        relay: None,
        quic_bind: SocketAddr::from(([127, 0, 0, 1], 0)),
        http_bind: SocketAddr::from(([127, 0, 0, 1], 0)),
        lookup: None,
        domain: None,
        access: None,
        push: Some(
            Service::open(
                &server_dir,
                PushOptions {
                    allowed: Allowed::parse(&["127.0.0.0/8".into()]).unwrap(),
                    ..Default::default()
                },
            )
            .unwrap(),
        ),
        pages: None,
        views: None,
    })
    .await
    .unwrap();
    let url = format!("http://{}/push", serving.addr());
    let distributor = distributor().await;
    let dir = tmp("phone");
    let (phone, laptop, host) = (key(), key(), key());

    let endpoint = push::register(
        &dir,
        &phone,
        &url,
        (Platform::Unifiedpush, &distributor, false),
        &[laptop.public(), host.public()],
    )
    .await
    .unwrap();
    assert!(endpoint.starts_with(&format!("{url}/")), "{endpoint}");
    assert_eq!(post(&endpoint, &laptop).await, 201);
    assert_eq!(post(&endpoint, &host).await, 201);

    // The laptop unpaired: the phone registers again, naming the host alone.
    assert!(push::register_again(&dir, &phone, &[host.public()])
        .await
        .unwrap());
    assert_eq!(post(&endpoint, &laptop).await, 404);
    assert_eq!(post(&endpoint, &host).await, 201);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let kept = std::fs::metadata(dir.join("push-server.json")).unwrap();
        assert_eq!(kept.permissions().mode() & 0o777, 0o600);
    }

    // A phone that registered nowhere: nothing to do.
    assert!(
        !push::register_again(&tmp("nowhere"), &key(), &[host.public()])
            .await
            .unwrap()
    );
}

/// A network's server on this machine: its access role, which lets on any device that registers,
/// and its push role beside it, which registers a phone only while the access role lets it on. The
/// server, its access role's URL and its push role's, and its admin's key.
async fn network() -> (Serving, String, String, SecretKey) {
    let (dir, admin) = (tmp("network"), key());
    let access = access::Service::open(&dir, admin.public(), Policy::OpenPow, 0).unwrap();
    let push = Service::open(
        &dir,
        PushOptions {
            allowed: Allowed::parse(&["127.0.0.0/8".into()]).unwrap(),
            admits: Some(access.clone()),
            ..Default::default()
        },
    )
    .unwrap();
    let serving = Serving::spawn(Options {
        bind: "127.0.0.1:0".parse().unwrap(),
        certificate: None,
        relay: None,
        quic_bind: SocketAddr::from(([127, 0, 0, 1], 0)),
        http_bind: SocketAddr::from(([127, 0, 0, 1], 0)),
        lookup: None,
        domain: None,
        access: Some(access),
        push: Some(push),
        pages: None,
        views: None,
    })
    .await
    .unwrap();
    let base = format!("http://{}", serving.addr());
    (
        serving,
        format!("{base}/access"),
        format!("{base}/push"),
        admin,
    )
}

/// A phone in `dir` paired with `desk`, on the network and registered at its push server, naming
/// the desk: the address the desk tells it at.
async fn registered(
    dir: &std::path::Path,
    desk: &Desk,
    access_url: &str,
    push_url: &str,
) -> String {
    let phone = paired_with(dir, desk);
    access::client::register(access_url, phone.key())
        .await
        .unwrap();
    let to = (Platform::Unifiedpush, distributor().await, false);
    let senders = push::senders(&phone).unwrap();
    push::register(dir, phone.key(), push_url, (to.0, &to.1, to.2), &senders)
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_phone_unpairing_the_device_that_let_it_onto_the_network_registers_again_before_that_device_takes_it_off(
) {
    let (_serving, access_url, push_url, admin) = network().await;
    let desk = Desk::start(41).await;
    let dir = support::tmp("unpair-on-network");
    let endpoint = registered(&dir, &desk, &access_url, &push_url).await;
    assert_eq!(post(&endpoint, &support::key(41)).await, 201);

    // Told, the desk takes the phone off the network at once.
    let phone = hive_phone::identity::Identity::open(&dir).unwrap();
    let off = (access_url.clone(), phone.key().public(), admin.clone());
    desk.on_unpair(std::sync::Arc::new(move || {
        let (access_url, phone, admin) = off.clone();
        Box::pin(async move {
            access::client::revoke(&access_url, &phone, &admin)
                .await
                .unwrap();
        })
    }));
    let net = hive_net::net::endpoint(phone.key().clone(), &phone.reach(), vec![])
        .await
        .unwrap();
    let unpaired = phone.unpair_from(&net, &desk.id).await.unwrap();
    net.close().await;

    assert!(unpaired.told);
    assert!(
        unpaired.still_pushes.is_none(),
        "{:?}",
        unpaired.still_pushes
    );
    assert_eq!(post(&endpoint, &support::key(41)).await, 404);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hive_phone_unpair_says_when_the_push_server_still_lets_the_device_tell_the_phone_and_exits_2(
) {
    let (_serving, access_url, push_url, admin) = network().await;
    let desk = Desk::start(42).await;
    let dir = support::tmp("unpair-still-pushes");
    let endpoint = registered(&dir, &desk, &access_url, &push_url).await;
    // The network let the phone go: its push server takes no registration of it now.
    let phone = hive_phone::identity::Identity::open(&dir)
        .unwrap()
        .key()
        .public();
    access::client::revoke(&access_url, &phone, &admin)
        .await
        .unwrap();

    let identity = dir.clone();
    let ran = tokio::task::spawn_blocking(move || {
        Command::new(env!("CARGO_BIN_EXE_hive-phone"))
            .args(["unpair", "desk", "--json", "--identity"])
            .arg(identity)
            .output()
            .unwrap()
    })
    .await
    .unwrap();
    let said: Value = serde_json::from_slice(&ran.stdout).unwrap_or(Value::Null);
    let stderr = String::from_utf8_lossy(&ran.stderr);

    assert_eq!(
        (ran.status.code(), said),
        (
            Some(2),
            json!({
                "device": desk.id, "name": "desk", "told": true, "stillPushes": true,
                "pushError": format!("{push_url} refused: this phone is not on the network"),
            })
        ),
        "{stderr}"
    );
    assert!(
        stderr.contains("the push server still lets desk tell this phone"),
        "{stderr}"
    );
    assert_eq!(post(&endpoint, &support::key(42)).await, 201);
}
