//! What a phone keeps of a pairing (devices.rs, identity.rs; spec/pairing.md "After"): the
//! certificate given, as its own, and the device it paired with, among the person's; pairing again
//! with another of the person's devices keeps both, and with another person's device the phone is
//! that person, the first one's devices forgotten. Only an entry whose certificate verifies, names
//! its device and is the phone's person's is listed; a certificate that does not name the phone is
//! not its own. What each device last answered is kept, and forgotten with the device
//! (spec/needs.md "Asking", spec/pairing.md "Unpairing"); and the network an app gives, which the
//! phone reaches the person's devices through (spec/pairing.md 0.5).

use std::{fs, path::PathBuf};

use hive_net::net::Reach;
use hive_phone::{
    devices::PairedDevice,
    identity::{DeviceCertificate, Identity},
    needs::{Answer, Heard, Need},
    pairing::{Paired, PairedWith},
};
use iroh::SecretKey;

fn key(n: u8) -> SecretKey {
    SecretKey::from_bytes(&[n; 32])
}
/// "Device `device` is `person`'s", signed by the person key: what an app gives.
fn certify(person: &SecretKey, device: &str) -> DeviceCertificate {
    let issued_at = 1_790_000_000_000u64;
    let mut bytes = b"hive/device-certificate/1\n".to_vec();
    bytes.extend(person.public().as_bytes());
    bytes.extend(hex::decode(device).unwrap());
    bytes.extend(issued_at.to_be_bytes());
    DeviceCertificate {
        v: 1,
        person: person.public().to_string(),
        device: device.to_string(),
        issued_at,
        signature: hex::encode(person.sign(&bytes).to_bytes()),
    }
}
/// A pairing of `phone` with the app `app`, of `person`.
fn paired(phone: &Identity, app: u8, person: &SecretKey) -> Paired {
    let device = key(app).public().to_string();
    Paired {
        with: PairedWith {
            device: device.clone(),
            name: format!("app {app}"),
            kind: "app".into(),
            certificate: certify(person, &device),
            addrs: vec![format!("10.0.0.{app}:4433")],
            relay: None,
        },
        certificate: certify(person, &phone.id()),
        network: None,
    }
}
/// A folder of the test `name`'s own, empty.
fn tmp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("hive-phone-keep-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    dir
}
fn names(devices: &[PairedDevice]) -> Vec<&str> {
    devices.iter().map(|d| d.with.name.as_str()).collect()
}

#[test]
fn a_phone_keeps_the_app_it_paired_with_and_the_certificate_given_as_its_own() {
    let dir = tmp("first");
    let phone = Identity::open(&dir.join("id")).unwrap();
    assert!(phone.certificate().is_none());
    assert!(phone.devices().is_empty());
    let priya = key(1);
    let first = paired(&phone, 10, &priya);
    phone.keep(&first, 1_000).unwrap();

    assert_eq!(phone.certificate(), Some(first.certificate.clone()));
    assert_eq!(
        phone.devices(),
        vec![PairedDevice {
            with: first.with.clone(),
            paired_at: 1_000
        }]
    );
    // Kept as the app keeps its own: readable by this user alone, and read again as it was.
    let again = Identity::open(&dir.join("id")).unwrap();
    assert_eq!(again.id(), phone.id());
    assert_eq!(again.devices(), phone.devices());
    #[cfg(unix)]
    for (file, kept) in [
        ("", 0o700),
        ("device.key", 0o600),
        ("device.cert", 0o600),
        ("devices.json", 0o600),
    ] {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(dir.join("id").join(file))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, kept, "{file}");
    }
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn pairing_again_keeps_the_persons_devices_and_another_persons_device_makes_the_phone_that_person()
{
    let dir = tmp("again");
    let phone = Identity::open(&dir.join("id")).unwrap();
    let (priya, sam) = (key(1), key(2));
    phone.keep(&paired(&phone, 10, &priya), 1).unwrap();
    phone.keep(&paired(&phone, 11, &priya), 2).unwrap();
    // The same device again: one entry, as it is now.
    phone.keep(&paired(&phone, 10, &priya), 3).unwrap();
    assert_eq!(names(&phone.devices()), ["app 11", "app 10"]);
    assert_eq!(phone.devices()[1].paired_at, 3);

    phone.keep(&paired(&phone, 20, &sam), 4).unwrap();
    assert_eq!(
        phone.certificate().unwrap().person,
        sam.public().to_string()
    );
    assert_eq!(names(&phone.devices()), ["app 20"]);
    // Forgotten, not hidden: nothing of the first person's devices is kept.
    let kept = fs::read_to_string(dir.join("id").join("devices.json")).unwrap();
    assert_eq!(
        serde_json::from_str::<Vec<serde_json::Value>>(&kept)
            .unwrap()
            .len(),
        1
    );
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn only_what_checks_out_is_listed_and_a_certificate_for_another_device_is_not_the_phones() {
    let dir = tmp("checks");
    let phone = Identity::open(&dir.join("id")).unwrap();
    let priya = key(1);
    phone.keep(&paired(&phone, 10, &priya), 1).unwrap();
    let file = dir.join("id").join("devices.json");
    let mut all: Vec<serde_json::Value> =
        serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    let good = all[0].clone();
    // One whose signature was changed, one whose certificate names another device, and one of
    // another person's.
    let mut forged = paired(&phone, 11, &priya);
    forged.with.certificate.signature.replace_range(
        0..2,
        if &forged.with.certificate.signature[0..2] == "00" {
            "01"
        } else {
            "00"
        },
    );
    let mut moved = paired(&phone, 12, &priya);
    moved.with.certificate = certify(&priya, &key(13).public().to_string());
    let theirs = paired(&phone, 14, &key(2));
    for p in [forged, moved, theirs] {
        all.push(
            serde_json::to_value(PairedDevice {
                with: p.with,
                paired_at: 1,
            })
            .unwrap(),
        );
    }
    fs::write(&file, serde_json::to_string(&all).unwrap()).unwrap();
    assert_eq!(names(&phone.devices()), ["app 10"]);
    assert_eq!(serde_json::to_value(&phone.devices()[0]).unwrap(), good);

    // A certificate naming another phone, in place of its own: it is no one's, and lists nothing.
    let other = certify(&priya, &key(30).public().to_string());
    fs::write(
        dir.join("id").join("device.cert"),
        serde_json::to_string(&other).unwrap(),
    )
    .unwrap();
    assert!(phone.certificate().is_none());
    assert!(phone.devices().is_empty());
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn what_each_device_last_answered_is_kept_until_it_is_forgotten_and_another_person_forgets_all_of_it(
) {
    let dir = tmp("heard");
    let phone = Identity::open(&dir.join("id")).unwrap();
    let (priya, sam) = (key(1), key(2));
    let (a, b) = (paired(&phone, 10, &priya), paired(&phone, 11, &priya));
    phone.keep(&a, 1).unwrap();
    phone.keep(&b, 2).unwrap();
    let waiting = Need {
        workspace: "a1".repeat(16),
        name: "api".into(),
        tile: "t1".into(),
        agent: "Nav fix".into(),
        kind: "permission".into(),
        since: 4,
        plan: None,
    };
    let said = |needs: Vec<Need>, working| Answer { needs, working };
    let (from_a, from_b) = (a.with.device.clone(), b.with.device.clone());
    phone
        .hear(
            &[
                (from_a.clone(), said(vec![], 1)),
                (from_b.clone(), said(vec![], 2)),
            ],
            5,
        )
        .unwrap();
    // What a device says next is kept in place of what it said before.
    phone
        .hear(&[(from_a.clone(), said(vec![waiting.clone()], 3))], 6)
        .unwrap();
    let heard = phone.heard();
    assert_eq!(
        heard[&from_a],
        Heard {
            at: 6,
            answer: said(vec![waiting], 3)
        }
    );
    assert_eq!(
        heard[&from_b],
        Heard {
            at: 5,
            answer: said(vec![], 2)
        }
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let file = dir.join("id").join("heard.json");
        assert_eq!(
            fs::metadata(file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    // A device forgotten: no longer one of the person's to the phone, nor what it said kept.
    assert!(phone.forget(&from_a).unwrap());
    assert_eq!(names(&phone.devices()), ["app 11"]);
    assert_eq!(phone.heard().into_keys().collect::<Vec<_>>(), [from_b]);
    assert!(!phone.forget(&from_a).unwrap(), "not one of them any more");

    // Another person's device: what the first person's devices said goes with them.
    phone.keep(&paired(&phone, 20, &sam), 7).unwrap();
    assert!(phone.heard().is_empty());
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn the_network_an_app_gives_is_kept_and_reached_through_until_another_persons_app_gives_its_own_or_none(
) {
    let dir = tmp("network");
    let phone = Identity::open(&dir.join("id")).unwrap();
    let (priya, sam) = (key(1), key(2));
    assert!(phone.network().is_none());
    assert_eq!(phone.reach(), Reach::local());
    let profiles: serde_json::Value =
        serde_json::from_str(include_str!("../../../conformance/network-profile.json")).unwrap();
    let corp = profiles["valid"][0]["file"].to_string();

    let mut first = paired(&phone, 10, &priya);
    first.network = Some(corp);
    phone.keep(&first, 1).unwrap();
    assert_eq!(phone.network().unwrap().profile.name, "Example Corp");
    let reach = phone.reach();
    assert_eq!(
        reach
            .relays
            .iter()
            .map(|r| r.to_string())
            .collect::<Vec<_>>(),
        ["https://relay.hive.example.com/"]
    );
    assert!(reach.mdns, "and the local network too");
    // A device that says it is reached through another relay is dialled through that one too.
    let relays = |r: Reach| r.relays.iter().map(|r| r.to_string()).collect::<Vec<_>>();
    assert_eq!(
        relays(phone.reach_through(Some("https://relay.elsewhere.example/"))),
        [
            "https://relay.hive.example.com/",
            "https://relay.elsewhere.example/"
        ]
    );
    assert_eq!(
        relays(phone.reach_through(Some("https://relay.hive.example.com/"))),
        ["https://relay.hive.example.com/"]
    );
    assert_eq!(phone.reach_through(None), phone.reach());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let file = dir.join("id").join("network.json");
        assert_eq!(
            fs::metadata(file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    // The same person's app on no network of its own: the phone stays on theirs.
    phone.keep(&paired(&phone, 11, &priya), 2).unwrap();
    assert_eq!(phone.network().unwrap().profile.name, "Example Corp");

    // Another person's app: its network, or the local one alone.
    let mut theirs = paired(&phone, 20, &sam);
    theirs.network = Some("hosted".into());
    phone.keep(&theirs, 3).unwrap();
    assert_eq!(phone.network().unwrap().builtin, Some("hosted"));
    phone.keep(&paired(&phone, 30, &key(3)), 4).unwrap();
    assert!(phone.network().is_none());
    assert_eq!(phone.reach(), Reach::local());
    fs::remove_dir_all(&dir).unwrap();
}
