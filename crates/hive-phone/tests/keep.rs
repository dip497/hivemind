//! What a phone keeps of a pairing (devices.rs, identity.rs; spec/pairing.md "After"): the
//! certificate given, as its own, and the device it paired with, among the person's; pairing again
//! with another of the person's devices keeps both, and with another person's device the phone is
//! that person, the first one's devices forgotten. Only an entry whose certificate verifies, names
//! its device and is the phone's person's is listed; a certificate that does not name the phone is
//! not its own. What each device last answered is kept, and forgotten with the device
//! (spec/needs.md "Asking", spec/pairing.md "Unpairing"): its agents as it listed them, what waits
//! on the person among them, and the workspaces it holds (spec/agents.md "Following"), or what
//! waits on the person, as a device that does not list them answers; nothing of what waits there
//! until it has said, though it told the workspaces it holds, and when it said it; the computers
//! and hosts an app tells of, kept as it told of them while an app that did lists them
//! (spec/pairing.md 0.7), and whose they are as the app paired with first says (0.8); a device
//! found away is shown back once, when it says it is back since then (spec/push.md 0.2); and the
//! network an app gives, which the phone reaches the person's devices through (spec/pairing.md
//! 0.5).

use std::{fs, path::PathBuf};

use hive_net::net::Reach;
use hive_phone::{
    agents::{Agent, Listed, Waiting},
    devices::PairedDevice,
    identity::{DeviceCertificate, Identity},
    needs::{Answer, Heard, Need},
    pairing::{Paired, PairedWith},
    person::Person,
    workspace::Held,
};
use iroh::SecretKey;
use serde_json::json;

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
            paired_at: 1_000,
            via: vec![],
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
                via: vec![],
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
        machine: Some("app 10".into()),
        decide: true,
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
            answer: Some(said(vec![waiting], 3)),
            answered: Some(6),
            agents: None,
            workspaces: vec![],
        }
    );
    assert_eq!(
        heard[&from_b],
        Heard {
            at: 5,
            answer: Some(said(vec![], 2)),
            answered: Some(5),
            agents: None,
            workspaces: vec![],
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
fn what_a_device_lists_is_kept_whole_with_what_waits_on_the_person_among_it_and_the_workspaces_it_holds_until_it_answers_otherwise(
) {
    let dir = tmp("listed");
    let phone = Identity::open(&dir.join("id")).unwrap();
    let a = paired(&phone, 10, &key(1));
    phone.keep(&a, 1).unwrap();
    let device = a.with.device.clone();
    let agent = |tile: &str, state: &str, waiting: Option<Waiting>| Agent {
        workspace: "w1".into(),
        name: "api".into(),
        tile: tile.into(),
        agent: format!("agent of {tile}"),
        program: None,
        state: state.into(),
        since: 4,
        machine: "app 10".into(),
        waiting,
        interrupt: false,
        device: device.clone(),
    };
    let waits = |kind: &str| {
        Some(Waiting {
            kind: kind.into(),
            since: 4,
            plan: None,
            decide: kind == "permission",
        })
    };
    let listed = Listed {
        agents: vec![
            agent("t1", "working", None),
            agent("t2", "waiting", waits("permission")),
            agent("t3", "waiting", waits("approval")),
        ],
        working: 1,
    };
    let held = [Held {
        workspace: "w1".into(),
        name: "api".into(),
        folder: Some("/home/priya/api".into()),
    }];
    phone.hear_workspaces(&device, &held, 2).unwrap();
    phone.mark_away(std::slice::from_ref(&device), 2).unwrap();
    phone.hear_agents(&device, &listed, 3).unwrap();
    let heard = phone.heard().remove(&device).unwrap();
    assert_eq!(heard.at, 3);
    assert_eq!(heard.listed(&device), Some(listed));
    assert_eq!(heard.workspaces, held);
    // What waits on the person among them: not what waits on the agent supervising it.
    let permission = Need {
        workspace: "w1".into(),
        name: "api".into(),
        tile: "t2".into(),
        agent: "agent of t2".into(),
        kind: "permission".into(),
        since: 4,
        plan: None,
        machine: Some("app 10".into()),
        decide: true,
    };
    assert_eq!(
        heard.answer,
        Some(Answer {
            needs: vec![permission.clone()],
            working: 1
        })
    );
    assert!(phone.away().is_empty(), "it listed them since");

    // Answering what waits on the person instead, as a device that does not list its agents: those
    // are its agents now.
    let plan = Need {
        tile: "t4".into(),
        agent: "agent of t4".into(),
        kind: "plan".into(),
        plan: Some("do it".into()),
        decide: false,
        ..permission
    };
    let answer = Answer {
        needs: vec![plan],
        working: 0,
    };
    phone.hear(&[(device.clone(), answer)], 5).unwrap();
    let heard = phone.heard().remove(&device).unwrap();
    assert_eq!(heard.agents, None);
    assert_eq!(heard.workspaces, held);
    let plan = agent(
        "t4",
        "waiting",
        Some(Waiting {
            kind: "plan".into(),
            since: 4,
            plan: Some("do it".into()),
            decide: false,
        }),
    );
    assert_eq!(
        heard.listed(&device),
        Some(Listed {
            agents: vec![plan],
            working: 0
        })
    );
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_device_that_told_only_the_workspaces_it_holds_has_said_nothing_of_what_waits_there_until_it_answers(
) {
    let dir = tmp("asking");
    let phone = Identity::open(&dir.join("id")).unwrap();
    let a = paired(&phone, 10, &key(1));
    phone.keep(&a, 1).unwrap();
    let device = a.with.device.clone();
    let held = [Held {
        workspace: "w1".into(),
        name: "api".into(),
        folder: None,
    }];
    // Reached, a device tells the workspaces it holds before what waits there: not that nothing
    // does, nor that no agent is at work.
    phone.hear_workspaces(&device, &held, 2).unwrap();
    let heard = phone.heard().remove(&device).unwrap();
    assert_eq!(heard.workspaces, held);
    assert_eq!(heard.answer, None);
    assert_eq!(heard.answered, None);
    assert_eq!(heard.listed(&device), None);

    // Answered, it is known from then on, and when it said it, whatever it tells after.
    let answer = Answer {
        needs: vec![],
        working: 2,
    };
    phone.hear(&[(device.clone(), answer.clone())], 3).unwrap();
    phone.hear_workspaces(&device, &held, 4).unwrap();
    let heard = phone.heard().remove(&device).unwrap();
    assert_eq!(
        (heard.at, heard.answer, heard.answered),
        (4, Some(answer), Some(3))
    );
    // Its list of agents says it again, as of then.
    let listed = Listed {
        agents: vec![],
        working: 1,
    };
    phone.hear_agents(&device, &listed, 5).unwrap();
    assert_eq!(phone.heard()[&device].answered, Some(5));
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn what_a_phone_of_before_kept_of_a_device_is_its_answer_said_when_it_last_told_anything() {
    let dir = tmp("before");
    let phone = Identity::open(&dir.join("id")).unwrap();
    let a = paired(&phone, 10, &key(1));
    phone.keep(&a, 1).unwrap();
    let device = a.with.device.clone();
    // As heard.json was written before a device's answer and when it said it were kept apart.
    let kept = json!({ device.clone(): { "at": 7, "needs": [], "working": 1 } });
    fs::write(dir.join("id").join("heard.json"), kept.to_string()).unwrap();
    let heard = phone.heard().remove(&device).unwrap();
    let answer = Answer {
        needs: vec![],
        working: 1,
    };
    assert_eq!((heard.answer, heard.answered), (Some(answer), Some(7)));
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_device_found_away_is_shown_back_once_when_it_says_so_since_then_and_answering_again_or_forgotten_it_is_not_away(
) {
    let dir = tmp("away");
    let phone = Identity::open(&dir.join("id")).unwrap();
    let (priya, sam) = (key(1), key(2));
    let (a, b) = (paired(&phone, 10, &priya), paired(&phone, 11, &priya));
    phone.keep(&a, 1).unwrap();
    phone.keep(&b, 2).unwrap();
    let (a, b) = (a.with.device, b.with.device);
    let since = |away: &[(&String, u64)]| {
        away.iter()
            .map(|&(d, at)| (d.clone(), at))
            .collect::<std::collections::BTreeMap<_, _>>()
    };
    // Neither answered at 10.
    phone.mark_away(&[a.clone(), b.clone()], 10).unwrap();
    assert_eq!(phone.away(), since(&[(&a, 10), (&b, 10)]));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let file = dir.join("id").join("away.json");
        assert_eq!(
            fs::metadata(file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    // Back since before the phone found it away: a notice that came late, not shown.
    assert!(!phone.back(&a, 9).unwrap());
    // Back since then: shown, once.
    assert!(phone.back(&a, 12).unwrap());
    assert!(!phone.back(&a, 13).unwrap(), "not away any more");
    assert_eq!(phone.away(), since(&[(&b, 10)]));
    // One never found away, or not one of the person's devices, is not shown back.
    assert!(!phone.back(&key(12).public().to_string(), 14).unwrap());

    // Found away again, later: back since between the two is late.
    phone.mark_away(std::slice::from_ref(&b), 20).unwrap();
    assert!(!phone.back(&b, 15).unwrap());
    // Answering, it is not away.
    let said = Answer {
        needs: vec![],
        working: 0,
    };
    phone.hear(&[(b.clone(), said)], 21).unwrap();
    assert!(phone.away().is_empty());
    assert!(!phone.back(&b, 22).unwrap());

    // Forgotten, it is not away; nor are the first person's devices once the phone is another's.
    phone.mark_away(&[a.clone(), b.clone()], 23).unwrap();
    assert!(phone.forget(&a).unwrap());
    assert_eq!(phone.away(), since(&[(&b, 23)]));
    phone.keep(&paired(&phone, 20, &sam), 24).unwrap();
    assert!(phone.away().is_empty());
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn the_computers_and_hosts_an_app_tells_of_are_kept_as_it_told_of_them_until_no_app_that_told_of_them_lists_them(
) {
    let dir = tmp("learn");
    let phone = Identity::open(&dir.join("id")).unwrap();
    let (priya, sam) = (key(1), key(2));
    let (desk, laptop) = (paired(&phone, 10, &priya), paired(&phone, 11, &priya));
    phone.keep(&desk, 1).unwrap();
    phone.keep(&laptop, 2).unwrap();
    let (desk, laptop) = (desk.with.device, laptop.with.device);
    // A host of Priya's, as an app names it.
    let device = |n: u8, kind: &str, of: &SecretKey| {
        let id = key(n).public().to_string();
        PairedWith {
            device: id.clone(),
            name: format!("{kind} {n}"),
            kind: kind.into(),
            certificate: certify(of, &id),
            addrs: vec![format!("10.0.0.{n}:4433")],
            relay: None,
        }
    };
    let told = |d: &PairedWith| serde_json::to_value(d).unwrap();
    let (box_, mini) = (device(20, "host", &priya), device(21, "app", &priya));
    let learned = |with: &PairedWith, at: u64, via: &[&String]| PairedDevice {
        with: with.clone(),
        paired_at: at,
        via: via.iter().map(|v| v.to_string()).collect(),
    };

    phone.learn(&desk, &[told(&box_), told(&mini)], 5).unwrap();
    assert_eq!(
        phone.devices()[2..],
        [learned(&box_, 5, &[&desk]), learned(&mini, 5, &[&desk])]
    );
    // Told of by the laptop too; named again as it is now, kept from when the phone learned of it.
    let renamed = PairedWith {
        name: "build box".into(),
        ..box_.clone()
    };
    phone.learn(&laptop, &[told(&renamed)], 6).unwrap();
    assert_eq!(
        phone.devices()[2..],
        [
            learned(&renamed, 5, &[&desk, &laptop]),
            learned(&mini, 5, &[&desk])
        ]
    );
    // The desk lists neither any more: the mini goes, the box stays while the laptop lists it.
    phone.learn(&desk, &[], 7).unwrap();
    assert_eq!(phone.devices()[2..], [learned(&renamed, 5, &[&laptop])]);
    phone.learn(&laptop, &[], 8).unwrap();
    assert_eq!(names(&phone.devices()), ["app 10", "app 11"]);

    // Not the person's, a phone, a certificate for another device, one the phone paired with
    // itself: none is kept as told.
    let mut moved = box_.clone();
    moved.certificate = certify(&priya, &key(22).public().to_string());
    let paired_itself = PairedWith {
        name: "renamed".into(),
        ..paired(&phone, 11, &priya).with
    };
    let none = [
        told(&device(23, "host", &sam)),
        told(&device(24, "phone", &priya)),
        told(&moved),
        told(&paired_itself),
        json!("a host"),
    ];
    phone.learn(&desk, &none, 9).unwrap();
    // As written, not only as read back.
    let written: Vec<serde_json::Value> =
        serde_json::from_str(&fs::read_to_string(dir.join("id").join("devices.json")).unwrap())
            .unwrap();
    assert_eq!(
        written
            .iter()
            .map(|d| d["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["app 10", "app 11"]
    );
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

#[test]
fn whose_devices_these_are_is_as_the_app_paired_with_first_says_a_name_that_is_none_not_taken_and_another_person_forgets_it(
) {
    let dir = tmp("person");
    let phone = Identity::open(&dir.join("id")).unwrap();
    let (priya, sam) = (key(1), key(2));
    let (desk, laptop) = (paired(&phone, 10, &priya), paired(&phone, 11, &priya));
    phone.keep(&desk, 1).unwrap();
    phone.keep(&laptop, 2).unwrap();
    let (desk_id, laptop_id) = (desk.with.device.clone(), laptop.with.device.clone());
    let said = |name: &str, color: &str| json!({ "t": "devices", "devices": [], "profile": { "name": name, "color": color } });
    assert_eq!(phone.person(), None, "none before an app says");

    // Both say: the desk, paired with first, is whose word is kept, whatever order they answer in.
    phone
        .learn_all(
            &[
                (laptop_id.clone(), said("Priya S", "#10b981")),
                (desk_id.clone(), said("  Priya  ", "#3b82f6")),
            ],
            3,
        )
        .unwrap();
    assert_eq!(
        phone.person(),
        Some(Person {
            name: "Priya".into(),
            color: "#3b82f6".into()
        })
    );
    // The desk away, the laptop's word is kept; a colour that is not one is taken as none.
    phone
        .learn_all(&[(laptop_id.clone(), said("Priya S", "blue"))], 4)
        .unwrap();
    assert_eq!(
        phone.person(),
        Some(Person {
            name: "Priya S".into(),
            color: String::new()
        })
    );
    // A name that is none, too long or with a control character is not taken; nor anything from
    // a device this phone did not pair with itself.
    for name in ["", "   ", &"P".repeat(65), "Priya\nS"] {
        phone
            .learn_all(&[(desk_id.clone(), said(name, "#3b82f6"))], 5)
            .unwrap();
        assert_eq!(phone.person().unwrap().name, "Priya S", "{name:?}");
    }
    phone
        .learn_all(
            &[(key(12).public().to_string(), said("Mallory", "#000000"))],
            6,
        )
        .unwrap();
    assert_eq!(phone.person().unwrap().name, "Priya S");
    phone
        .learn_all(
            &[(desk_id.clone(), json!({ "t": "devices", "devices": [] }))],
            7,
        )
        .unwrap();
    assert_eq!(
        phone.person().unwrap().name,
        "Priya S",
        "an app that says none leaves it"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(dir.join("id").join("person.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    // Paired with another person's app: whose they were is forgotten.
    phone.keep(&paired(&phone, 20, &sam), 8).unwrap();
    assert_eq!(phone.person(), None);
}
