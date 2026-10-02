//! What waits on the person (spec/needs.md), held to conformance/needs.json's cases for a phone:
//! the answers the person's devices give, shown as one list, the one waiting longest first, each
//! item on the machine it says, else on the device that answered, with an item that does not say
//! all it must left out, and the agents at work on them counted together. A device's side is held
//! to the same file in packages/host.

use hive_phone::needs::{as_one, read_answer, Need};
use serde_json::Value;

#[test]
fn the_answers_of_the_persons_devices_are_shown_as_one_list_the_one_waiting_longest_first_with_the_agents_at_work(
) {
    let cases: Value =
        serde_json::from_str(include_str!("../../../conformance/needs.json")).unwrap();
    let cases = cases["phone"].as_array().unwrap();
    assert!(!cases.is_empty());
    for c in cases {
        let from = c["from"].as_array().unwrap();
        let shown = as_one(
            c["answers"]
                .as_array()
                .unwrap()
                .iter()
                .zip(from)
                .map(|(answer, from)| read_answer(answer, from.as_str().unwrap()))
                .collect(),
        );
        let expected: Vec<Need> = serde_json::from_value(c["needs"].clone()).unwrap();
        assert_eq!(shown.needs, expected, "{}", c["about"]);
        assert_eq!(Some(shown.working), c["working"].as_u64(), "{}", c["about"]);
    }
}
