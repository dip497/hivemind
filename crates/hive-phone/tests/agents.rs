//! Every agent of the person's (spec/agents.md "Following"), held to conformance/agents.json's
//! cases for a phone: each device's list read as it sent it, with that device, an item that cannot
//! be read left out and what it says only as true taken only as true; what waits on the person
//! among them as one list, the one waiting longest first; and the agents at work counted together.
//! A device's side is held to the same file in packages/host.

use hive_phone::agents::{as_one, read_answer};
use serde_json::Value;

#[test]
fn each_devices_agents_are_shown_with_what_waits_on_the_person_among_them_the_one_waiting_longest_first(
) {
    let cases: Value =
        serde_json::from_str(include_str!("../../../conformance/agents.json")).unwrap();
    let cases = cases["phone"].as_array().unwrap();
    assert!(!cases.is_empty());
    for c in cases {
        let shown = as_one(
            c["answers"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|a| read_answer(&a["answer"], a["from"].as_str().unwrap()))
                .collect(),
        );
        // As JSON, not read back as agents: a field the reading drops would be dropped from both.
        let agents = serde_json::to_value(&shown.agents).unwrap();
        assert_eq!(agents, c["agents"], "{}", c["about"]);
        let needs: Vec<String> = shown
            .needs
            .iter()
            .map(|a| format!("{}/{}", a.device, a.tile))
            .collect();
        assert_eq!(
            serde_json::to_value(needs).unwrap(),
            c["needs"],
            "{}",
            c["about"]
        );
        assert_eq!(Some(shown.working), c["working"].as_u64(), "{}", c["about"]);
    }
}
