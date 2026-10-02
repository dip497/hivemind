//! What an agent and the person say to each other, followed from the phone (talking.rs;
//! docs/design/phone-app-2026-10-02.md §5.4): told oldest first, each entry once, the first
//! telling anew and each after adding to it, but the first of a session the agent begins, which is
//! anew; followed on across a dropped connection from as far as it was told, in the session it was
//! told of; ended, told why, once and last, when the device refuses it or does not hold its
//! workspace. Stopped, it tells nothing more, not even what was on its way, and lets go of it.

mod support;

use std::{
    sync::{atomic::Ordering::SeqCst, Arc, Mutex, OnceLock},
    time::Duration,
};

use hive_phone::{
    connections::Connections,
    conversation::Entry,
    failure::Lost,
    talking::{Listener, Talking},
};
use serde_json::{json, Value};
use support::{paired_with, tmp, until, Desk, SESSION, TILE, WORKSPACE};

/// What a conversation told: each telling's entries, by id, and whether anew; and why it ended.
#[derive(Default)]
struct Told {
    said: Mutex<Vec<(Vec<String>, bool)>>,
    ended: Mutex<Vec<Lost>>,
    /// Told the entry of this id, it is stopped a moment later.
    stop_on: Option<&'static str>,
    talking: OnceLock<Talking>,
}

impl Listener for Told {
    fn said(&self, entries: Vec<Entry>, anew: bool) {
        let ids: Vec<String> = entries.into_iter().map(|e| e.id).collect();
        let stop = self.stop_on.is_some_and(|id| ids.iter().any(|i| i == id));
        self.said.lock().unwrap().push((ids, anew));
        if stop {
            std::thread::sleep(Duration::from_millis(500));
            self.talking.get().unwrap().stop();
        }
    }

    fn ended(&self, why: Lost) {
        self.ended.lock().unwrap().push(why);
    }
}

impl Told {
    /// Every entry told, by id, in the order told.
    fn ids(&self) -> Vec<String> {
        let said = self.said.lock().unwrap();
        said.iter().flat_map(|(ids, _)| ids.clone()).collect()
    }
}

/// What the person or the agent said.
fn entry(id: &str, who: &str, text: &str) -> Value {
    json!({ "id": id, "at": 1_790_000_000_000u64, "who": who, "text": text })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn what_is_said_is_told_once_oldest_first_and_followed_on_from_as_far_as_it_was_told_across_a_dropped_connection(
) {
    let desk = Desk::start(41).await;
    let phone = paired_with(&tmp("talking"), &desk);
    let connections = Connections::new(phone.clone(), || {});
    connections.foreground();
    desk.say(10, entry("e1", "person", "fix the nav"));
    desk.say(20, entry("e2", "agent", "On it."));
    let told = Arc::new(Told::default());
    let _talking = Talking::start(&connections, &desk.id, WORKSPACE, TILE, told.clone());
    assert!(until(Duration::from_secs(10), || told.ids() == ["e1", "e2"]).await);
    desk.say(30, entry("e3", "agent", "Done."));
    assert!(until(Duration::from_secs(10), || told.ids().len() == 3).await);

    // The connection drops: on the next, it is asked from as far as it was told.
    desk.drop_connections();
    let asked = || desk.asked_from.lock().unwrap().len() == 2;
    assert!(until(Duration::from_secs(10), asked).await);
    desk.say(40, entry("e4", "person", "thanks"));
    assert!(until(Duration::from_secs(10), || told.ids().len() == 4).await);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(told.ids(), ["e1", "e2", "e3", "e4"]);
    let resumed = Some((SESSION.to_string(), 30));
    assert_eq!(*desk.asked_from.lock().unwrap(), [None, resumed]);
    // The first telling is anew; each after adds to it, and tells something.
    let tellings = told.said.lock().unwrap().clone();
    assert!(tellings[0].1);
    assert!(
        tellings[1..]
            .iter()
            .all(|(ids, anew)| !anew && !ids.is_empty()),
        "{tellings:?}"
    );
    assert!(told.ended.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_the_agent_begins_is_told_anew_and_followed_on_in_it_across_a_dropped_connection()
{
    let desk = Desk::start(44).await;
    let phone = paired_with(&tmp("anew"), &desk);
    let connections = Connections::new(phone.clone(), || {});
    connections.foreground();
    desk.say(10, entry("e1", "person", "fix the nav"));
    desk.say(20, entry("e2", "agent", "On it."));
    let told = Arc::new(Told::default());
    let _talking = Talking::start(&connections, &desk.id, WORKSPACE, TILE, told.clone());
    assert!(until(Duration::from_secs(10), || told.ids() == ["e1", "e2"]).await);

    // `/clear`: another session, its file's cursors its own.
    desk.begin("s2", vec![(5, entry("e3", "person", "now the footer"))]);
    assert!(until(Duration::from_secs(10), || told.ids().len() == 3).await);
    // The connection drops: on the next, it is asked from as far as it was told, in that session.
    desk.drop_connections();
    let asked = || desk.asked_from.lock().unwrap().len() == 2;
    assert!(until(Duration::from_secs(10), asked).await);
    desk.say(9, entry("e4", "agent", "Footer done."));
    assert!(until(Duration::from_secs(10), || told.ids().len() == 4).await);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(told.ids(), ["e1", "e2", "e3", "e4"]);
    assert_eq!(
        *desk.asked_from.lock().unwrap(),
        [None, Some(("s2".to_string(), 5))]
    );
    let anew: Vec<bool> = told.said.lock().unwrap().iter().map(|t| t.1).collect();
    assert_eq!(anew, [true, true, false]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_conversation_the_device_refuses_or_does_not_hold_ends_told_why_once() {
    let desk = Desk::start(42).await;
    let phone = paired_with(&tmp("refused"), &desk);
    let connections = Connections::new(phone.clone(), || {});
    connections.foreground();
    desk.say(10, entry("e1", "person", "fix the nav"));
    let cases = [
        (WORKSPACE, "t9", Lost::Refused("no agent runs there".into())),
        (
            "elsewhere",
            TILE,
            Lost::NotHeld("desk does not hold that workspace now".into()),
        ),
    ];
    for (workspace, tile, why) in cases {
        let told = Arc::new(Told::default());
        let _talking = Talking::start(&connections, &desk.id, workspace, tile, told.clone());
        let ended = || !told.ended.lock().unwrap().is_empty();
        assert!(until(Duration::from_secs(10), ended).await, "{why:?}");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(told.said.lock().unwrap().is_empty(), "{why:?}");
        assert_eq!(*told.ended.lock().unwrap(), [why]);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_conversation_stopped_tells_nothing_more_not_even_what_was_on_its_way_and_lets_go_of_it()
{
    let desk = Desk::start(43).await;
    let phone = paired_with(&tmp("stopped"), &desk);
    let connections = Connections::new(phone.clone(), || {});
    connections.foreground();
    desk.say(10, entry("e1", "person", "fix the nav"));
    // Told e2, the app stops it a moment later: e3 comes meanwhile.
    let told = Arc::new(Told {
        stop_on: Some("e2"),
        ..Told::default()
    });
    let talking = Talking::start(&connections, &desk.id, WORKSPACE, TILE, told.clone());
    let _ = told.talking.set(talking);
    assert!(until(Duration::from_secs(10), || told.ids() == ["e1"]).await);
    desk.say(20, entry("e2", "agent", "On it."));
    assert!(until(Duration::from_secs(10), || told.ids().len() == 2).await);
    desk.say(30, entry("e3", "agent", "Done."));
    assert!(until(Duration::from_secs(5), || desk.left.load(SeqCst) == 1).await);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(told.ids(), ["e1", "e2"]);
    assert!(told.ended.lock().unwrap().is_empty());
}
