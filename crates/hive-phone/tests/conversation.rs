//! What an agent and the person said to each other (spec/agents.md "Conversation"), held to
//! conformance/conversation.json's cases for a phone: each entry a device sends that says what its
//! `who` says is read, in order; anything else is left out; and a tool use unfolded is read as the
//! device answers it. A device's side is held to the same file in packages/host.

mod support;

use hive_phone::{
    connections::Connections,
    conversation::{self, read_entries, Entry, Unfolded},
};
use serde_json::{json, Value};
use support::{paired_with, tmp, Desk, SESSION, TILE, WORKSPACE};

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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_answer_says_where_what_was_said_earlier_ends_and_a_page_of_it_comes_when_asked() {
    let desk = Desk::start(74).await;
    desk.begin(
        SESSION,
        vec![(
            9,
            json!({ "id": "e9", "at": 9, "who": "person", "text": "newest" }),
        )],
    );
    *desk.earlier.lock().unwrap() = Some((
        json!([{ "id": "e1", "at": 1, "who": "agent", "text": "older" }, { "id": "bad", "who": "nobody" }]),
        40,
    ));
    let phone = paired_with(&tmp("conversation-earlier"), &desk);
    let connections = Connections::new(phone.clone(), || {});
    connections.foreground();
    let connection = connections.holding(&desk.id, WORKSPACE).await.unwrap();

    let page = conversation::earlier(&connection, WORKSPACE, TILE, SESSION, 100)
        .await
        .unwrap();
    assert_eq!(page.before, 40);
    assert_eq!(
        page.entries
            .iter()
            .map(|e| e.id.as_str())
            .collect::<Vec<_>>(),
        vec!["e1"]
    );
    assert_eq!(
        *desk.asked_earlier.lock().unwrap(),
        vec![json!([TILE, SESSION, 100])]
    );

    // A page that does not go back would be asked for for ever.
    let stuck = conversation::earlier(&connection, WORKSPACE, TILE, SESSION, 40).await;
    assert!(stuck.is_err(), "{stuck:?}");
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
