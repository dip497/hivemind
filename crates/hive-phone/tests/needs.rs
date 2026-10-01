//! What waits on the person (spec/needs.md), held to conformance/needs.json's cases for a phone:
//! the answers the person's devices give, shown as one list, the one waiting longest first, with
//! an item that does not say all it must left out. A device's side is held to the same file in
//! packages/host.

use hive_phone::needs::{as_one, read_answer, Need};
use serde_json::Value;

#[test]
fn the_answers_of_the_persons_devices_are_shown_as_one_list_the_one_waiting_longest_first() {
    let cases: Value =
        serde_json::from_str(include_str!("../../../conformance/needs.json")).unwrap();
    let cases = cases["phone"].as_array().unwrap();
    assert!(!cases.is_empty());
    for c in cases {
        let shown = as_one(
            c["answers"]
                .as_array()
                .unwrap()
                .iter()
                .map(read_answer)
                .collect(),
        );
        let expected: Vec<Need> = serde_json::from_value(c["needs"].clone()).unwrap();
        assert_eq!(shown, expected, "{}", c["about"]);
    }
}
