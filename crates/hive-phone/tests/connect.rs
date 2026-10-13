//! Connecting (spec/pairing.md 0.10), the phone's side, held to conformance/pairing.json: cases
//! made apart from this code (Python's hmac), which the app's TypeScript is held to as well. Proofs,
//! words and links are the spec's; the phone shows the words of the app's answer to its ask, takes
//! nothing but "it's me", and keeps only a certificate naming it as the app's person; every answer
//! changed in a way that matters is refused.

use hive_phone::{
    connect::{asked, parse_link, proof, taken, told, words, ConnectLink},
    failure::Failure,
    identity::DeviceCertificate,
    person::Person,
};
use serde_json::{json, Value};

fn cases() -> Value {
    serde_json::from_str(include_str!("../../../conformance/pairing.json")).unwrap()
}
fn text(v: &Value) -> &str {
    v.as_str().unwrap()
}

#[test]
fn connecting_proofs_are_hmac_sha256_keyed_by_the_code_of_its_label_and_the_two_devices() {
    let cases = cases();
    let cases = cases["connect"]["proof"].as_array().unwrap();
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
fn a_requests_words_are_the_specs() {
    for c in cases()["connect"]["words"].as_array().unwrap() {
        let made = words(
            text(&c["code"]),
            text(&c["offering"]),
            text(&c["entering"]),
            text(&c["nonceO"]),
            text(&c["nonceJ"]),
        );
        assert_eq!(json!(made), c["words"], "{}", c["about"]);
    }
}

#[test]
fn an_offers_link_is_read_as_the_spec_says_or_is_not_one() {
    for c in cases()["connect"]["link"].as_array().unwrap() {
        let read = parse_link(text(&c["text"])).map(|l| serde_json::to_value(l).unwrap());
        assert_eq!(read.unwrap_or(Value::Null), c["link"], "{}", c["about"]);
    }
}

/// The app and phone of the pairing case, the app's offer, and the words case for its request.
struct Case {
    link: ConnectLink,
    me: String,
    nonce_o: String,
    nonce_j: String,
    words: Value,
    phone: Value,
}

fn case() -> Case {
    let cases = cases();
    let link = parse_link(text(&cases["connect"]["link"][0]["text"])).unwrap();
    let w = cases["connect"]["words"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["about"] == "a phone's request")
        .unwrap()
        .clone();
    assert_eq!(
        (text(&w["code"]), text(&w["offering"])),
        (link.code.as_str(), link.device.as_str())
    );
    Case {
        link,
        me: text(&w["entering"]).into(),
        nonce_o: text(&w["nonceO"]).into(),
        nonce_j: text(&w["nonceJ"]).into(),
        words: w["words"].clone(),
        phone: cases["phone"].clone(),
    }
}

impl Case {
    /// The app's answer to the phone's ask, as the spec has it.
    fn answer(&self) -> Value {
        json!({
            "ok": true, "request": "0123456789abcdef", "proof": proof(&self.link.code, "offering", &self.link.device, &self.me),
            "nonce": self.nonce_o, "name": "Priya's desktop", "certificate": self.phone["answer"]["certificate"],
            "addrs": ["192.168.1.20:41641"], "relay": null,
        })
    }
}

fn refused_as(result: anyhow::Result<impl std::fmt::Debug>) -> Option<String> {
    match result.unwrap_err().downcast::<Failure>() {
        Ok(Failure::Refused { code, .. }) => code,
        other => panic!("not refused: {other:?}"),
    }
}

#[test]
fn the_phone_shows_the_words_of_the_apps_answer_and_keeps_the_app_as_it_answered() {
    let c = case();
    assert_eq!(c.me, text(&c.phone["phone"]["device"]));
    let a = asked(&c.me, &c.link, &c.nonce_j, &c.answer()).unwrap();
    assert_eq!(json!(a.words), c.words);
    assert_eq!(a.request, "0123456789abcdef");
    assert_eq!(
        (
            a.with.device.as_str(),
            a.with.name.as_str(),
            a.with.kind.as_str()
        ),
        (c.link.device.as_str(), "Priya's desktop", "app")
    );
    let theirs: DeviceCertificate =
        serde_json::from_value(c.phone["answer"]["certificate"].clone()).unwrap();
    assert_eq!(a.with.certificate, theirs);
    assert_eq!(a.with.addrs, vec!["192.168.1.20:41641".to_string()]);
}

#[test]
fn the_phone_refuses_an_answer_to_its_ask_that_does_not_check_out() {
    let c = case();
    let changed = |key: &str, value: Value| {
        let mut answer = c.answer();
        answer[key] = value;
        asked(&c.me, &c.link, &c.nonce_j, &answer)
    };
    assert!(changed(
        "proof",
        json!(proof(&c.link.code, "entering", &c.link.device, &c.me))
    )
    .is_err());
    assert!(changed("certificate", c.phone["answer"]["yours"].clone()).is_err());
    assert!(changed("nonce", json!("not hex")).is_err());
    assert!(changed("request", json!(null)).is_err());
    assert!(changed("request", json!("../../another")).is_err());
    assert!(changed("name", json!("")).is_err());
    // Another phone, which proved nothing to this app.
    let other = text(&c.phone["app"]["device"]);
    assert!(asked(other, &c.link, &c.nonce_j, &c.answer()).is_err());
    assert_eq!(
        refused_as(asked(
            &c.me,
            &c.link,
            &c.nonce_j,
            &json!({ "ok": false, "error": "busy" })
        )),
        Some("busy".into())
    );
}

#[test]
fn told_it_is_theirs_the_phone_shows_whose_and_a_no_is_a_refusal() {
    let profile = json!({ "name": "Priya", "color": "#336699" });
    assert_eq!(
        told(&json!({ "ok": true, "as": "me", "profile": profile })).unwrap(),
        Some(Person {
            name: "Priya".into(),
            color: "#336699".into()
        })
    );
    // A phone is never someone else.
    assert!(told(&json!({ "ok": true, "as": "guest", "workspace": "0f".repeat(16) })).is_err());
    assert_eq!(
        refused_as(told(&json!({ "ok": false, "error": "declined" }))),
        Some("declined".into())
    );
}

#[test]
fn taking_the_phone_keeps_a_certificate_naming_it_as_the_apps_person_and_nothing_else() {
    let c = case();
    let a = asked(&c.me, &c.link, &c.nonce_j, &c.answer()).unwrap();
    let yours = c.phone["answer"]["yours"].clone();
    let paired = taken(&c.me, &a, &json!({ "ok": true, "yours": yours })).unwrap();
    let mine: DeviceCertificate = serde_json::from_value(yours.clone()).unwrap();
    assert_eq!(
        (paired.with, paired.certificate, paired.network),
        (a.with.clone(), mine, None)
    );

    // One naming another device, or the person of another app, is refused.
    let theirs = c.phone["answer"]["certificate"].clone();
    assert!(taken(&c.me, &a, &json!({ "ok": true, "yours": theirs })).is_err());
    let mut elsewhere = a.clone();
    elsewhere.with.certificate.person = "0".repeat(64);
    assert!(taken(&c.me, &elsewhere, &json!({ "ok": true, "yours": yours })).is_err());
    assert_eq!(
        refused_as(taken(
            &c.me,
            &a,
            &json!({ "ok": false, "error": "expired" })
        )),
        Some("expired".into())
    );
}
