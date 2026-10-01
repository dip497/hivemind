//! Pairing (spec/pairing.md 0.3), held to conformance/pairing.json: cases made apart from this code
//! (Python's hmac and OpenSSL's Ed25519), which the app's TypeScript is held to as well. The phone's
//! side here: proofs, codes and links are the spec's; the phone proves itself to the app in the
//! case's words; it keeps what the app's answer gives; and it refuses every answer changed in any
//! way that matters, keeping nothing of it.

use hive_phone::{
    identity::DeviceCertificate,
    pairing::{accept, parse_code, parse_link, proof, prove, PairLink, PairedWith},
};
use iroh::SecretKey;
use serde_json::Value;

fn cases() -> Value {
    serde_json::from_str(include_str!("../../../conformance/pairing.json")).unwrap()
}
fn text(v: &Value) -> &str {
    v.as_str().unwrap()
}
fn seed(hex_seed: &str) -> SecretKey {
    let mut bytes = [0u8; 32];
    hex::decode_to_slice(hex_seed, &mut bytes).unwrap();
    SecretKey::from_bytes(&bytes)
}

#[test]
fn a_proof_is_hmac_sha256_keyed_by_the_code_of_its_label_and_the_two_devices() {
    let cases = cases();
    let cases = cases["proof"].as_array().unwrap();
    assert!(!cases.is_empty());
    for c in cases {
        let made = proof(
            text(&c["code"]),
            text(&c["label"]),
            text(&c["offering"]),
            text(&c["entering"]),
        );
        assert_eq!(made, text(&c["proof"]), "{c}");
    }
}

#[test]
fn a_code_is_six_of_the_words_however_they_are_typed_and_anything_else_is_none() {
    for c in cases()["code"].as_array().unwrap() {
        assert_eq!(
            parse_code(text(&c["text"])).as_deref(),
            c["code"].as_str(),
            "{}",
            c["about"]
        );
    }
}

#[test]
fn a_link_is_read_as_the_spec_says_or_is_not_one() {
    for c in cases()["link"].as_array().unwrap() {
        let read = parse_link(text(&c["text"])).map(|l| serde_json::to_value(l).unwrap());
        assert_eq!(read.unwrap_or(Value::Null), c["link"], "{}", c["about"]);
    }
}

#[test]
fn a_phone_proves_itself_to_the_app_whose_link_it_scanned_and_keeps_what_the_answer_gives() {
    let cases = cases();
    let p = &cases["phone"];
    let phone = seed(text(&p["phone"]["deviceSeed"]));
    let me = phone.public().to_string();
    assert_eq!(me, text(&p["phone"]["device"]));
    let link: PairLink = parse_link(text(&p["link"])).unwrap();
    assert_eq!(link.device, text(&p["app"]["device"]));
    assert_eq!(link.code, text(&p["code"]));

    let addrs: Vec<String> = serde_json::from_value(p["phone"]["addrs"].clone()).unwrap();
    let hello = prove(
        &me,
        text(&p["phone"]["name"]),
        &addrs,
        p["phone"]["relay"].as_str(),
        &link,
    );
    assert_eq!(hello, p["prove"]);

    let paired = accept(&me, &link, &p["answer"]).unwrap();
    let kept: PairedWith = serde_json::from_value(p["paired"].clone()).unwrap();
    assert_eq!(paired.with, kept);
    let mine: DeviceCertificate = serde_json::from_value(p["certificate"].clone()).unwrap();
    assert_eq!(paired.certificate, mine);
}

#[test]
fn a_phone_refuses_every_answer_that_does_not_check_out() {
    let cases = cases();
    let p = &cases["phone"];
    let me = text(&p["phone"]["device"]);
    let link = parse_link(text(&p["link"])).unwrap();
    let refused = p["refused"].as_array().unwrap();
    assert!(!refused.is_empty());
    for c in refused {
        assert!(accept(me, &link, &c["answer"]).is_err(), "{}", c["about"]);
    }
    // The answer as it is, to another phone, which did not prove anything to this app.
    let other = SecretKey::from_bytes(&[7u8; 32]).public().to_string();
    assert!(accept(&other, &link, &p["answer"]).is_err());
}
