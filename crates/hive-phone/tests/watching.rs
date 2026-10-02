//! An agent's terminal, watched from the phone (watching.rs, workspace.rs; docs/design/phone-app-
//! 2026-10-02.md §5.3): its screen drawn by the core at the size the session took; who holds its
//! keyboard told by name, and none once this phone holds it; what the person types goes in as it
//! is, in order, the keyboard asked for first and keys a moment apart; its end told with its code.
//! A watch stopped lets go of the terminal.

mod support;

use std::{
    sync::{atomic::Ordering::SeqCst, Arc, Mutex},
    time::Duration,
};

use hive_phone::{
    connections::Connections,
    watching::{Watcher, Watching},
};
use serde_json::json;
use support::{paired_with, tmp, until, Desk, TILE, WORKSPACE};

/// What a watch told.
#[derive(Default)]
struct Told {
    frames: Mutex<Vec<u64>>,
    keyboards: Mutex<Vec<Option<String>>>,
    ended: Mutex<Option<Option<i64>>>,
}

impl Watcher for Told {
    fn frame_ready(&self, revision: u64) {
        self.frames.lock().unwrap().push(revision);
    }

    fn keyboard(&self, holder: Option<String>) {
        self.keyboards.lock().unwrap().push(holder);
    }

    fn ended(&self, code: Option<i64>) {
        *self.ended.lock().unwrap() = Some(code);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_watched_terminal_is_drawn_at_its_size_and_typed_into_as_the_person_in_order() {
    let desk = Desk::start(31).await;
    let phone = paired_with(&tmp("watching"), &desk);
    let connections = Connections::new(phone.clone(), || {});
    connections.foreground();
    let told = Arc::new(Told::default());
    let watching = Watching::start(
        &connections,
        &phone.id(),
        &desk.id,
        WORKSPACE,
        TILE,
        told.clone(),
    );
    let drawn = || {
        let frame = watching.newest();
        let first = frame.changed(0).next().map(|(_, line)| line.text.clone());
        (frame.cols, frame.rows, first)
    };
    let screen = (100, 30, Some("Hello from the agent".to_string()));
    assert!(
        until(Duration::from_secs(10), || drawn() == screen).await,
        "{:?}",
        drawn()
    );
    assert!(!told.frames.lock().unwrap().is_empty());
    assert_eq!(
        told.keyboards.lock().unwrap()[..],
        [Some("Sam".to_string())]
    );

    watching.type_text("ls -la".into());
    let keys = ["Enter", "down", "down", "ctrl-c"];
    watching.type_keys(keys.map(String::from).to_vec());
    let ended = || told.ended.lock().unwrap().is_some();
    assert!(until(Duration::from_secs(10), ended).await);
    assert_eq!(*told.ended.lock().unwrap(), Some(Some(3)));
    let session = format!("hm:{TILE}");
    let write = |data: &str| json!({ "method": "terminal.write", "params": [session, data] });
    assert_eq!(
        desk.notices(),
        [
            json!({ "method": "terminal.keyboard.ask", "params": [session] }),
            write("ls -la"),
            write("\r"),
            write("\x1b[B"),
            write("\x1b[B"),
            write("\x03"),
        ]
    );
    // Three gaps of 40 ms between the four keys, give or take how late each one came.
    let told_at: Vec<_> = desk
        .told
        .lock()
        .unwrap()
        .iter()
        .map(|(at, _)| *at)
        .collect();
    assert!(told_at[5] - told_at[2] >= Duration::from_millis(60));
    // Given to this phone, its keyboard is the person's own.
    assert_eq!(told.keyboards.lock().unwrap().last(), Some(&None));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_watch_stopped_lets_go_of_the_terminal_even_once_the_person_typed() {
    let desk = Desk::start(32).await;
    let phone = paired_with(&tmp("stopped"), &desk);
    let connections = Connections::new(phone.clone(), || {});
    connections.foreground();
    let told = Arc::new(Told::default());
    let watching = Watching::start(
        &connections,
        &phone.id(),
        &desk.id,
        WORKSPACE,
        TILE,
        told.clone(),
    );
    watching.type_text("y".into());
    assert!(until(Duration::from_secs(10), || desk.notices().len() == 2).await);
    watching.stop();
    assert!(until(Duration::from_secs(5), || desk.left.load(SeqCst) == 1).await);
    // Its connection is the phone's still, for all else.
    assert!(connections.seen()[0].reachable);
}
