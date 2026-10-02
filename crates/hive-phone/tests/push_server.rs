//! A phone on a network with a push server (push.rs, spec/push.md 0.3): it registers there to be
//! told by the devices it names, keeping where; registering again, as it does once it unpairs a
//! device, leaves that device out, so what it posts is not passed on. A phone that registered
//! nowhere registers nowhere again.

use std::{net::SocketAddr, path::PathBuf};

use hive_net::{
    egress::Allowed,
    push::{Options as PushOptions, Platform, Service},
    serve::{Options, Serving},
};
use hive_phone::push;
use iroh::SecretKey;
use sha2::{Digest, Sha256};
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
