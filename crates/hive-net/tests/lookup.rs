// The lookup role and the relay as devices live with them (R13, §12.2, §5.8): a device found by its
// id alone, through the lookup server, where it said which relay it is on, and not without it; a
// workspace's host record, kept signed by the workspace's key, read by anyone, replaced by a newer
// one, and never by one somebody else signed; a reader that checks the signature itself; the
// lookup server holding back many records from one address, whatever the request says it was
// forwarded for (the address it came from counts); and a relay restarted under its devices, which
// reconnect and are still let in.

mod support;

use std::{net::TcpListener, str::FromStr, thread, time::Duration};

use hive_net::{host_record::HostRecord, key};
use iroh::PublicKey;
use serde_json::Value;
use support::*;

fn relay() -> (Running, String) {
    let running = start(&["serve", "--relay", "--bind", "127.0.0.1:0"], &[]);
    let url = running.after("relay serving on ");
    (running, url)
}

/// A lookup server keeping its records under `root`; `limit` is how it holds back publishing.
fn lookup(root: &std::path::Path, limit: &str) -> (Running, String) {
    let running = start(
        &[
            "serve",
            "--lookup",
            "--data",
            root.join("server").to_str().unwrap(),
            "--bind",
            "127.0.0.1:0",
            "--lookup-limit",
            limit,
        ],
        &[],
    );
    let url = running.after("lookup serving on ");
    (running, url)
}

/// Where the lookup server `lookup` keeps what `key` signed.
fn record_of(lookup: &str, key: &str) -> String {
    format!("{lookup}/{}", PublicKey::from_str(key).unwrap().to_z32())
}

#[test]
fn a_device_is_found_by_its_id_alone_through_the_lookup_server_and_not_without_it() {
    let root = temp("lookup");
    let (a, _) = device(&root, "a");
    let (b, _) = device(&root, "b");
    // A and B are on different relays; nothing tells B which one A is on but the lookup server.
    let (_r1, relay1) = relay();
    let (_r2, relay2) = relay();
    let (_l, lookup) = lookup(&root, "off");
    let a_runs = start(
        &[
            "run",
            "--identity",
            &a,
            "--relay",
            &relay2,
            "--lookup",
            &lookup,
        ],
        &[],
    );
    let id = a_runs.after("");
    assert!(
        eventually(Duration::from_secs(20), || http(
            "GET",
            &record_of(&lookup, &id),
            &[],
            b""
        )
        .0 == 200),
        "A never said where it is"
    );
    let ping = |with_lookup: bool| {
        let mut args = vec!["ping", &id, "--identity", &b, "--relay", &relay1];
        if with_lookup {
            args.extend(["--lookup", &lookup]);
        }
        hive_net(&args, &[])
    };
    let found = ping(true);
    assert!(found.status.success(), "{}", text(&found));
    assert!(text(&found).contains("through a relay"), "{}", text(&found));
    let not = ping(false);
    assert!(
        !not.status.success(),
        "found without the lookup server: {}",
        text(&not)
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_host_record_is_kept_signed_by_the_workspaces_key_read_by_anyone_and_never_replaced_by_another_key(
) {
    let root = temp("host-record");
    let (owner, owner_id) = device(&root, "owner");
    let (_, laptop_id) = device(&root, "laptop");
    let (intruder, _) = device(&root, "intruder");
    let (_l, lookup) = lookup(&root, "off");
    let publish = |identity: &str, seq: &str, host: Option<&str>| {
        let mut args = vec![
            "host-record",
            "publish",
            "--identity",
            identity,
            "--lookup",
            &lookup,
            "--workspace",
            "ws-1",
            "--seq",
            seq,
        ];
        if let Some(host) = host {
            args.extend(["--host", host]);
        }
        let out = hive_net(&args, &[]);
        assert!(out.status.success(), "{}", text(&out));
        serde_json::from_slice::<Value>(&out.stdout).unwrap()
    };
    let resolve = |workspace: &str| {
        let out = hive_net(
            &["host-record", "resolve", workspace, "--lookup", &lookup],
            &[],
        );
        assert!(out.status.success(), "{}", text(&out));
        serde_json::from_slice::<Value>(&out.stdout).unwrap()
    };

    // This device hosts it; anyone with the workspace's key reads that.
    let published = publish(&owner, "1", None);
    let workspace = published["workspace"].as_str().unwrap().to_string();
    assert_eq!(
        resolve(&workspace),
        serde_json::json!({ "host": owner_id, "seq": 1 })
    );
    // It moves to the laptop: the newer record is the one read.
    publish(&owner, "2", Some(&laptop_id));
    assert_eq!(
        resolve(&workspace),
        serde_json::json!({ "host": laptop_id, "seq": 2 })
    );
    // Another person's "ws-1" is another workspace: it changes nothing here.
    let theirs = publish(&intruder, "9", None);
    assert_ne!(theirs["workspace"], published["workspace"]);
    assert_eq!(resolve(&workspace)["seq"], 2);
    // Nor does a record for this workspace signed by any other key.
    let other = key::workspace_key(
        &key::person_key(std::path::Path::new(&intruder)).unwrap(),
        "ws-1",
    )
    .unwrap();
    let forged = HostRecord {
        host: other.public(),
        seq: 3,
    }
    .sign(&other)
    .unwrap();
    let (status, _) = http(
        "PUT",
        &record_of(&lookup, &workspace),
        &[],
        &forged.to_relay_payload(),
    );
    assert!((400..500).contains(&status), "a forged record got {status}");
    assert_eq!(resolve(&workspace)["seq"], 2);
    // A workspace nobody said anything about: none.
    let unknown = hex::encode(rand::random::<[u8; 32]>());
    let unknown = iroh::SecretKey::from_bytes(&hex::decode(unknown).unwrap().try_into().unwrap())
        .public()
        .to_string();
    assert_eq!(resolve(&unknown), Value::Null);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_reader_checks_the_records_signature_whatever_the_lookup_server_hands_it() {
    // A lookup server that lies: whatever is asked for, a record somebody else signed.
    let liar = TcpListener::bind("127.0.0.1:0").unwrap();
    let at = liar.local_addr().unwrap();
    let someone = iroh::SecretKey::from_bytes(&rand::random::<[u8; 32]>());
    let payload = HostRecord {
        host: someone.public(),
        seq: 7,
    }
    .sign(&someone)
    .unwrap()
    .to_relay_payload();
    thread::spawn(move || {
        for stream in liar.incoming() {
            let mut stream = stream.unwrap();
            let mut buf = [0u8; 4096];
            let _ = std::io::Read::read(&mut stream, &mut buf);
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                payload.len()
            );
            let _ = std::io::Write::write_all(&mut stream, head.as_bytes());
            let _ = std::io::Write::write_all(&mut stream, &payload);
        }
    });
    let workspace = iroh::SecretKey::from_bytes(&rand::random::<[u8; 32]>())
        .public()
        .to_string();
    let out = hive_net(
        &[
            "host-record",
            "resolve",
            &workspace,
            "--lookup",
            &format!("http://{at}/pkarr"),
        ],
        &[],
    );
    assert!(
        !out.status.success(),
        "a record signed by another key was taken: {}",
        text(&out)
    );
    assert!(text(&out).contains("not signed"), "{}", text(&out));
}

#[test]
fn the_lookup_server_holds_back_many_records_from_one_address_whatever_it_says_it_forwards_for() {
    let root = temp("lookup-limit");
    let (_l, lookup) = lookup(&root, "per-address");
    // Seven records from here at once, each saying it comes from somewhere else.
    let statuses: Vec<u16> = (0..7)
        .map(|i| {
            let key = iroh::SecretKey::from_bytes(&rand::random::<[u8; 32]>());
            let packet = HostRecord {
                host: key.public(),
                seq: 1,
            }
            .sign(&key)
            .unwrap();
            let elsewhere = format!("203.0.113.{}", 10 + i);
            http(
                "PUT",
                &record_of(&lookup, &key.public().to_string()),
                &[("X-Forwarded-For", &elsewhere), ("X-Real-Ip", &elsewhere)],
                &packet.to_relay_payload(),
            )
            .0
        })
        .collect();
    assert!(
        statuses[..5].iter().all(|s| (200..300).contains(s)),
        "{statuses:?}"
    );
    assert_eq!(&statuses[5..], &[429, 429], "{statuses:?}");
    // Reading is not held back.
    let key = iroh::SecretKey::from_bytes(&rand::random::<[u8; 32]>());
    assert_eq!(
        http(
            "GET",
            &record_of(&lookup, &key.public().to_string()),
            &[],
            b""
        )
        .0,
        404
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_relay_restarted_under_its_devices_has_them_back_and_still_lets_in_only_whom_it_did() {
    let root = temp("restart");
    let admin = root.join("admin.key");
    std::fs::write(&admin, format!("{}\n", "b2".repeat(32))).unwrap();
    let voucher = |device: &str| {
        let out = hive_net(
            &[
                "access",
                "voucher",
                "--kind",
                "enrol",
                "--admin",
                admin.to_str().unwrap(),
                "--device",
                device,
            ],
            &[],
        );
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    };
    let (a, a_id) = device(&root, "a");
    let (b, b_id) = device(&root, "b");
    let (stranger, _) = device(&root, "stranger");
    let admin_id = serde_json::from_str::<Value>(&voucher(&a_id)).unwrap()["by"]
        .as_str()
        .unwrap()
        .to_string();
    let port = free_port().to_string();
    let bind = format!("127.0.0.1:{port}");
    let data = root.join("network");
    let serve = || {
        let running = start(
            &[
                "serve",
                "--relay",
                "--access",
                "--admin-id",
                &admin_id,
                "--data",
                data.to_str().unwrap(),
                "--bind",
                &bind,
            ],
            &[],
        );
        let relay = running.after("relay serving on ");
        let access = running.after("access serving on ");
        (running, relay, access)
    };
    let (server, relay, access) = serve();
    for id in [&a_id, &b_id] {
        let out = hive_net(&["access", "vouch", &access, &voucher(id)], &[]);
        assert!(out.status.success(), "{}", text(&out));
    }
    let a_runs = start(&["run", "--identity", &a, "--relay", &relay], &[]);
    let id = a_runs.after("");
    let ping = || hive_net(&["ping", &id, "--identity", &b, "--relay", &relay], &[]);
    let first = ping();
    assert!(first.status.success(), "{}", text(&first));

    // The relay goes, and comes back where it was.
    drop(server);
    let (_server, _, _) = serve();
    assert!(
        eventually(Duration::from_secs(60), || ping().status.success()),
        "A did not come back to the relay"
    );
    // A device nobody let in is still turned away, and told so.
    let doctor = hive_net(&["doctor", "--identity", &stranger, "--relay", &relay], &[]);
    let report: Value = serde_json::from_slice(&doctor.stdout).unwrap();
    assert_eq!(report["relays"][0]["ok"], false, "{report}");
    assert!(
        report["relays"][0]["refused"]
            .as_str()
            .is_some_and(|why| why.contains("not allowed")),
        "{report}"
    );
    std::fs::remove_dir_all(root).unwrap();
}
