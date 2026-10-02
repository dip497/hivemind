//! What a phone is sent (push.rs, spec/push.md), held to conformance/push.json: RFC 8291's example,
//! which the phone decrypts to its message with its own key and secret; a body changed on its way,
//! sent to another phone, cut short, of more than one record or from a key not given whole is
//! refused. A device's side
//! (encrypting) is held to the same file in packages/host.

use std::{fs, path::PathBuf};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hive_phone::push::PushKeys;
use serde_json::Value;

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
