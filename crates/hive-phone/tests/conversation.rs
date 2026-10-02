//! What an agent and the person said to each other (spec/agents.md "Conversation"), held to
//! conformance/conversation.json's cases for a phone: each entry a device sends that says what its
//! `who` says is read, in order; anything else is left out. A device's side is held to the same
//! file in packages/host.

use hive_phone::conversation::{read_entries, Entry};
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
