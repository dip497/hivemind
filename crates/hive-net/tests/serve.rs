// The server roles on one port over HTTPS (R13, §13.4), as a self-hosted network runs them:
// `serve --all` with a certificate kept in files makes the network's admin key and prints the
// network's link; devices that trust the certificate register, find each other by id through its
// lookup server and reach each other through its relay, and its doctor says each server answers;
// a device that does not trust it reaches none of them. On a closed network the admin's enrolment
// link puts a device on the relay, once.

mod support;

use std::{fs, path::Path};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rcgen::{BasicConstraints, CertificateParams, CertifiedIssuer, IsCa, KeyPair};
use serde_json::Value;
use support::*;

/// A certificate authority, and a certificate it signed for 127.0.0.1: the CA's file, and the
/// certificate's and its key's.
fn certificates(root: &Path) -> (String, String, String) {
    let mut ca = CertificateParams::new(Vec::<String>::new()).unwrap();
    ca.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    let ca = CertifiedIssuer::self_signed(ca, KeyPair::generate().unwrap()).unwrap();
    let key = KeyPair::generate().unwrap();
    let cert = CertificateParams::new(vec!["127.0.0.1".to_string()])
        .unwrap()
        .signed_by(&key, &ca)
        .unwrap();
    let file = |name: &str, pem: String| {
        let path = root.join(name);
        fs::write(&path, pem).unwrap();
        path.to_str().unwrap().to_string()
    };
    (
        file("ca.pem", ca.pem()),
        file("cert.pem", cert.pem()),
        file("key.pem", key.serialize_pem()),
    )
}

/// `serve --all` over HTTPS on `bind` with the certificate in files, and its extra `args`.
fn serve_https(root: &Path, cert: &str, key: &str, bind: &str, args: &[&str]) -> Running {
    let data = root.join("server");
    let mut all = vec![
        "serve",
        "--all",
        "--data",
        data.to_str().unwrap(),
        "--domain",
        "127.0.0.1",
        "--cert",
        cert,
        "--key",
        key,
        "--bind",
        bind,
        "--http-bind",
        "127.0.0.1:0",
        "--quic-bind",
        "127.0.0.1:0",
        "--lookup-limit",
        "off",
    ];
    all.extend_from_slice(args);
    start(&all, &[])
}

#[test]
fn a_network_served_over_https_on_one_port_is_used_by_the_devices_that_trust_its_certificate_and_no_others(
) {
    let root = temp("serve-https");
    let (ca, cert, key) = certificates(&root);
    let server = serve_https(
        &root,
        &cert,
        &key,
        "127.0.0.1:0",
        &["--policy", "open-pow", "--pow-bits", "8"],
    );
    let made = server.after("made the network's admin key, ");
    assert!(made.contains("admin.key"), "{made}");
    let relay = server.after("relay serving on ");
    assert!(relay.starts_with("https://127.0.0.1:"), "{relay}");
    assert_eq!(server.after("lookup serving on "), format!("{relay}/pkarr"));
    let access = server.after("access serving on ");
    assert_eq!(access, format!("{relay}/access"));
    let link = server.after("network link: ");

    // The link is the network: its relay, its lookup server and its access service, signed by
    // the admin key just made.
    let verified = hive_net(&["profile", "verify", &link], &[]);
    assert!(verified.status.success(), "{}", text(&verified));
    let verified: Value = serde_json::from_slice(&verified.stdout).unwrap();
    assert_eq!(verified["profile"]["relays"][0]["url"], relay.as_str());
    assert_eq!(verified["profile"]["lookup"], format!("{relay}/pkarr"));
    assert_eq!(verified["profile"]["access"]["url"], access.as_str());

    let trusting = [("SSL_CERT_FILE", ca.as_str())];
    let (a, _) = device(&root, "a");
    let (b, _) = device(&root, "b");
    for who in [&a, &b] {
        let out = hive_net(
            &["access", "register", &access, "--identity", who],
            &trusting,
        );
        assert!(out.status.success(), "{}", text(&out));
    }
    let a_runs = start(&["run", "--identity", &a, "--profile", &link], &trusting);
    let id = a_runs.after("");
    // B knows A's id and the network, nothing else: the lookup server says where A is.
    let ping = || {
        hive_net(
            &["ping", &id, "--identity", &b, "--profile", &link],
            &trusting,
        )
    };
    assert!(
        eventually(std::time::Duration::from_secs(30), || ping()
            .status
            .success()),
        "B never found A: {}",
        text(&ping())
    );
    let doctor = |env: &[(&str, &str)]| -> Value {
        let out = hive_net(&["doctor", "--identity", &b, "--profile", &link], env);
        serde_json::from_slice(&out.stdout).unwrap_or_else(|_| panic!("{}", text(&out)))
    };
    let trusted = doctor(&trusting);
    assert_eq!(trusted["relays"][0]["ok"], true, "{trusted}");
    assert_eq!(trusted["lookup"]["ok"], true, "{trusted}");
    assert_eq!(trusted["access"]["ok"], true, "{trusted}");
    // A device that does not trust the certificate reaches none of it.
    let untrusting = root.join("no-ca.pem");
    fs::write(&untrusting, "").unwrap();
    let not = doctor(&[("SSL_CERT_FILE", untrusting.to_str().unwrap())]);
    assert_eq!(not["relays"][0]["ok"], false, "{not}");
    assert_eq!(not["lookup"]["ok"], false, "{not}");
    assert_eq!(not["access"]["ok"], false, "{not}");
    drop(server);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn on_a_closed_network_the_admins_enrolment_link_puts_one_device_on_the_relay_and_the_link_is_kept()
{
    let root = temp("serve-enrol");
    let (ca, cert, key) = certificates(&root);
    let data = root.join("server");
    let bind = format!("127.0.0.1:{}", free_port());
    let server = serve_https(&root, &cert, &key, &bind, &[]);
    let relay = server.after("relay serving on ");
    let access = server.after("access serving on ");
    let link = server.after("network link: ");
    let trusting = [("SSL_CERT_FILE", ca.as_str())];

    // The admin, on the server: a link for one device.
    let enrol = hive_net(
        &[
            "access",
            "enrol-link",
            data.join("network.json").to_str().unwrap(),
            "--admin",
            data.join("admin.key").to_str().unwrap(),
        ],
        &[],
    );
    assert!(enrol.status.success(), "{}", text(&enrol));
    let enrol = String::from_utf8(enrol.stdout).unwrap().trim().to_string();
    // It is the network's link, with a voucher: what the app redeems when it is used.
    let carried: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(enrol.strip_prefix("hivemind://network/").unwrap())
            .unwrap(),
    )
    .unwrap();
    let voucher = carried["enrol"].to_string();
    assert_eq!(
        hive_net(&["profile", "verify", &enrol], &[]).stdout,
        hive_net(&["profile", "verify", &link], &[]).stdout
    );

    let (laptop, _) = device(&root, "laptop");
    let (other, _) = device(&root, "other");
    let admitted = |who: &str| -> bool {
        let out = hive_net(&["doctor", "--identity", who, "--relay", &relay], &trusting);
        let report: Value = serde_json::from_slice(&out.stdout).unwrap();
        report["relays"][0]["ok"].as_bool().unwrap()
    };
    assert!(!admitted(&laptop), "a device nobody enrolled got in");
    let redeem = |who: &str| {
        hive_net(
            &["access", "redeem", &access, &voucher, "--identity", who],
            &trusting,
        )
    };
    let out = redeem(&laptop);
    assert!(out.status.success(), "{}", text(&out));
    assert!(admitted(&laptop));
    // Once: the next device it is given to is not let in.
    assert!(!redeem(&other).status.success());
    assert!(!admitted(&other));

    // The server started again keeps its admin key and the same link.
    drop(server);
    let again = serve_https(&root, &cert, &key, &bind, &[]);
    assert_eq!(again.after("network link: "), link);
    fs::remove_dir_all(root).unwrap();
}
