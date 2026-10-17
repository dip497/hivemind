//! What a phone is sent (push.rs, spec/push.md), held to conformance/push.json: RFC 8291's example,
//! which the phone decrypts to its message with its own key and secret; a body changed on its way,
//! sent to another phone, cut short, of more than one record or from a key not given whole is
//! refused. A device's side
//! (encrypting) is held to the same file in packages/host. And where a phone with no push server
//! is told, and which notices it shows; through a push server, push_server.rs and the e2e. And the
//! VAPID key a phone gives its distributor: its network's push server's, when that server tells
//! phones through UnifiedPush. Each device told where takes it, says no in its words, or is away.

use std::{
    fs,
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hive_phone::{
    connections::Connections,
    identity::Identity,
    push::{self, Platform, PushAt, PushKeys, Took},
};
use serde_json::{json, Value};
use support::{paired_with, Desk};

mod support;

/// A phone whose push key and secret are `key` and `auth`, kept as a phone keeps its own.
fn phone_with(name: &str, key: &[u8], auth: &[u8]) -> PushKeys {
    let dir: PathBuf =
        std::env::temp_dir().join(format!("hive-phone-push-{}-{name}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("push.key"), hex::encode(key)).unwrap();
    fs::write(dir.join("push.auth"), hex::encode(auth)).unwrap();
    let keys = PushKeys::kept_or_made(&dir).unwrap();
    fs::remove_dir_all(&dir).unwrap();
    keys
}

/// A phone on the network whose push server is `push` (none: no push server), as pairing with an
/// app on that network keeps it: its profile, signed by the network's admin.
fn on_network(dir: &Path, push: Option<Value>) -> Identity {
    let _ = fs::remove_dir_all(dir);
    fs::create_dir_all(dir).unwrap();
    let admin = iroh::SecretKey::from_bytes(&[7; 32]);
    let mut profile =
        json!({ "v": 1, "name": "Priya's network", "admin": admin.public().to_string() });
    if let Some(push) = push {
        profile["push"] = push;
    }
    let signed = hive_net::profile::sign(&profile.to_string(), &admin).unwrap();
    let kept = serde_json::to_string(&serde_json::to_string(&signed).unwrap()).unwrap();
    fs::write(dir.join("network.json"), kept).unwrap();
    Identity::open(dir).unwrap()
}

fn b64(v: &Value) -> Vec<u8> {
    URL_SAFE_NO_PAD.decode(v.as_str().unwrap()).unwrap()
}

#[test]
fn a_phone_decrypts_what_it_is_sent_and_refuses_what_was_changed_cut_short_or_is_for_another_phone()
{
    let cases: Value =
        serde_json::from_str(include_str!("../../../conformance/push.json")).unwrap();
    let r = &cases["rfc8291"];
    let auth = b64(&r["auth"]);
    let phone = phone_with("ua", &b64(&r["uaPrivate"]), &auth);
    assert_eq!(phone.public(), b64(&r["uaPublic"]));
    let body = b64(&r["body"]);
    assert_eq!(phone.decrypt(&body).unwrap(), b64(&r["plaintext"]));

    // A byte changed anywhere after the salt and size: the key, or the record.
    for at in [30, 100, body.len() - 1] {
        let mut changed = body.clone();
        changed[at] ^= 1;
        assert!(phone.decrypt(&changed).is_err(), "byte {at} changed");
    }
    // The same key and another secret, or another key: not this phone's.
    assert!(phone_with("other secret", &b64(&r["uaPrivate"]), &[7; 16])
        .decrypt(&body)
        .is_err());
    assert!(phone_with("another key", &b64(&r["asPrivate"]), &auth)
        .decrypt(&body)
        .is_err());
    // Bodies for this phone that are no notice: cut short, of more than one record, or from a
    // key not given whole.
    let refused = cases["refused"].as_array().unwrap();
    assert_eq!(refused.len(), 3);
    for case in refused {
        assert!(
            phone.decrypt(&b64(&case["body"])).is_err(),
            "{}",
            case["about"]
        );
    }
}

#[tokio::test]
async fn a_phone_with_no_push_server_is_told_at_its_endpoint_itself_with_its_own_keys_and_a_token_is_refused(
) {
    let dir: PathBuf =
        std::env::temp_dir().join(format!("hive-phone-push-{}-direct", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let phone = Identity::open(&dir).unwrap();
    let told = push::subscribing(&phone, PushAt::Endpoint("https://up.example/up1"))
        .await
        .unwrap();
    let kept = PushKeys::kept_or_made(&dir).unwrap();
    assert_eq!(
        told.subscription,
        kept.subscription("https://up.example/up1", false),
        "unsigned, with the keys the phone reads its notices with"
    );
    assert_eq!((told.via, told.unregistered), (None, None));
    let apns = PushAt::Token {
        platform: Platform::Apns,
        token: "ab12",
        sandbox: false,
    };
    let refused = push::subscribing(&phone, apns).await.err().unwrap();
    assert!(
        format!("{refused:#}").contains("no push server that tells phones through \"apns\""),
        "{refused:#}"
    );
    // A notice is shown; a device back is only when the phone found it away.
    let needs = json!({ "v": 1, "t": "needs", "workspace": "w1", "tile": "t1", "since": 5 });
    assert!(push::shown(&phone, &needs).unwrap());
    let back = json!({ "v": 1, "t": "back", "device": "d1", "name": "desk", "since": 5 });
    assert!(!push::shown(&phone, &back).unwrap());
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_phone_gives_its_distributor_the_vapid_key_of_its_networks_push_server_that_tells_phones_through_unifiedpush(
) {
    let dir = std::env::temp_dir().join(format!("hive-phone-push-{}-vapid", std::process::id()));
    let vapid =
        "BOn2qVXAHmvWFAFd8BxBH2DFcZ3HfWdS7z3UzmkvylbP1zUiYvsZNRxvn6IBLE4TZwwH0ZE3yPrsJMn1YrlLJSs";
    let server = |kinds: Value| json!({ "url": "https://hive.example.com/push", "kinds": kinds, "vapid": vapid });
    let cases = [
        (
            Some(server(json!(["apns", "unifiedpush"]))),
            Some(vapid.to_string()),
        ),
        // It tells phones through Apple's service alone: not the distributor's to check.
        (Some(server(json!(["apns"]))), None),
        (None, None),
    ];
    for (push, given) in cases {
        let phone = on_network(&dir, push.clone());
        assert_eq!(push::vapid(&phone), given, "{push:?}");
    }
    // On no network but the local one.
    let _ = fs::remove_dir_all(&dir);
    assert_eq!(push::vapid(&Identity::open(&dir).unwrap()), None);
    fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_device_takes_where_the_phone_is_told_or_says_no_in_its_words_and_one_not_reached_is_away(
) {
    let desk = Desk::start(71).await;
    let dir = support::tmp("telling");
    let phone = paired_with(&dir, &desk);
    let connections = Connections::new(phone.clone(), || {});
    let keys = PushKeys::kept_or_made(&dir).unwrap();
    let subscription = keys.subscription("https://up.example/up1", false);
    let tell = |subscription| push::tell(connections.to(&desk.id), subscription);
    assert_eq!(tell(&subscription).await, Took::Yes);
    let refused = Took::Refused("not a push subscription".into());
    assert_eq!(tell(&json!({ "endpoint": 7 })).await, refused);
    let unreached = push::tell(connections.to("d9"), &subscription).await;
    assert_eq!(unreached, Took::Away);
}
