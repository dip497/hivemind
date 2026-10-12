//! What an agent and the person said to each other (spec/agents.md "Conversation"), held to
//! conformance/conversation.json's cases for a phone: each entry a device sends that says what its
//! `who` says is read, in order; anything else is left out; and a tool use unfolded is read as the
//! device answers it. A device's side is held to the same file in packages/host.

use hive_phone::conversation::{read_entries, Entry, Unfolded};
use serde_json::Value;

#[test]
fn the_entries_a_device_sends_are_read_as_the_spec_says() {
    let cases: Value =
        serde_json::from_str(include_str!("../../../conformance/conversation.json")).unwrap();
    let cases = cases["phone"].as_array().unwrap();
    assert!(!cases.is_empty());
    for c in cases {
        let expected: Vec<Entry> = serde_json::from_value(c["read"].clone()).unwrap();
        assert_eq!(read_entries(&c["entries"]), expected, "{}", c["about"]);
    }
}

#[test]
fn a_tool_unfolded_is_read_as_the_device_answers_it() {
    let cases: Value =
        serde_json::from_str(include_str!("../../../conformance/conversation.json")).unwrap();
    let answers: Vec<&Value> = ["mapped", "claude"]
        .iter()
        .flat_map(|k| cases["unfolded"][k].as_array().unwrap())
        .map(|c| &c["answer"])
        .filter(|a| !a.is_null())
        .collect();
    assert!(answers.len() >= 3);
    for answer in answers {
        let read: Unfolded = serde_json::from_value(answer.clone()).unwrap();
        assert_eq!(&serde_json::to_value(&read).unwrap(), answer);
    }
    let cut: Unfolded = serde_json::from_value(serde_json::json!({ "name": "Bash", "truncated": true, "result": { "text": "", "error": false } })).unwrap();
    assert_eq!(
        (cut.truncated, cut.result.map(|r| r.error)),
        (true, Some(false))
    );
}
