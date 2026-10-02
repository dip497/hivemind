//! A community view shown on the phone (viewing.rs, views.rs; docs/design/phone-app-2026-10-02.md
//! §6.1; spec/workspace-api.md "Views on a remote screen", 0.14): its files come with the policy
//! to serve them under, and one that comes with none is not served; opened on the device that
//! holds its workspace, on the phone's screen; what it posts goes to its host there, but what is not
//! JSON; what its host says comes back, in order; the screen told as it changes. Across a dropped
//! connection and the background it is opened again on the newest screen, told to start again,
//! and what the page of before posted until the view is ready again is dropped. It ends, told why
//! once, when its host disables it, the device refuses it or holds its workspace no more; stopped,
//! it tells nothing more and the device lets go of it.

mod support;

use std::{
    collections::BTreeMap,
    sync::{atomic::Ordering::SeqCst, Arc, Mutex},
    time::Duration,
};

use hive_phone::{
    connections::Connections,
    failure::Lost,
    viewing::{Ended, Viewer, Viewing},
    views::{self, Mode, Screen, Theme, ViewFile},
};
use serde_json::{json, Value};
use support::{paired_with, tmp, until, Desk, FLOODED, PAGE, POLICY, VIEW, WORKSPACE};

/// What a view shown told, in order.
#[derive(Debug, Clone, PartialEq)]
enum Told {
    Said(Value),
    Ended(Ended),
}

#[derive(Default)]
struct Shown(Mutex<Vec<Told>>);

impl Viewer for Shown {
    fn said(&self, message: Value) {
        self.0.lock().unwrap().push(Told::Said(message));
    }

    fn ended(&self, why: Ended) {
        self.0.lock().unwrap().push(Told::Ended(why));
    }
}

impl Shown {
    fn told(&self) -> Vec<Told> {
        self.0.lock().unwrap().clone()
    }
}

/// A phone's screen `w` by `h`, dark.
fn screen(w: u32, h: u32) -> Screen {
    let colors = BTreeMap::from([("bg".to_string(), "#101418".to_string())]);
    Screen {
        w,
        h,
        theme: Theme {
            colors,
            mode: Some(Mode::Dark),
            ..Theme::default()
        },
    }
}

/// The screen `w` by `h` as the protocol has it.
fn sent(w: u32, h: u32) -> Value {
    json!({ "w": w, "h": h, "theme": { "colors": { "bg": "#101418" }, "mode": "dark" } })
}

/// What the computer's host says to a view, ready, on the screen `w` by `h`.
fn hello(w: u32, h: u32) -> Told {
    let theme = json!({ "colors": { "bg": "#101418" }, "mode": "dark" });
    Told::Said(json!({ "type": "hello", "viewport": { "w": w, "h": h }, "theme": theme }))
}

const READY: &str = r#"{"type":"ready","v":1}"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_views_file_comes_with_the_policy_to_serve_it_under_and_one_with_none_is_not_served() {
    let desk = Desk::start(65).await;
    let phone = paired_with(&tmp("viewing-files"), &desk);
    let connections = Connections::new(phone.clone(), || {});
    connections.foreground();
    let connection = connections.holding(&desk.id, WORKSPACE).await.unwrap();
    let page = views::file(&connection, WORKSPACE, VIEW, "index.html").await;
    let served = ViewFile {
        bytes: PAGE.as_bytes().to_vec(),
        mime: "text/html; charset=utf-8".into(),
        csp: POLICY.into(),
    };
    assert_eq!(page.unwrap(), served);
    // As a device of before served it: served under no policy, it could reach the network.
    let old = views::file(&connection, WORKSPACE, VIEW, "old.html").await;
    assert!(old.is_err(), "{old:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_view_is_shown_on_the_phones_screen_its_posts_go_to_its_host_and_what_that_says_comes_back_in_order(
) {
    let desk = Desk::start(61).await;
    let phone = paired_with(&tmp("viewing"), &desk);
    let connections = Connections::new(phone.clone(), || {});
    connections.foreground();
    let shown = Arc::new(Shown::default());
    let viewing = Viewing::start(
        &connections,
        &desk.id,
        WORKSPACE,
        VIEW,
        screen(390, 844),
        shown.clone(),
    );
    viewing.post(READY);
    viewing.post("{not json");
    viewing.post(r#"{"type":"command","name":"selectTile","args":["t1"]}"#);
    let selected = json!({ "type": "command", "name": "selectTile", "args": ["t1"] });
    let echoed = Told::Said(json!({ "type": "echo", "of": selected }));
    let shown_first = [hello(390, 844), echoed];
    assert!(
        until(Duration::from_secs(10), || shown.told() == shown_first).await,
        "{:?}",
        shown.told()
    );
    // The phone turns.
    viewing.screen(screen(844, 390));
    let resized = Told::Said(json!({ "type": "resize", "w": 844, "h": 390 }));
    let all = [shown_first.to_vec(), vec![resized]].concat();
    assert!(
        until(Duration::from_secs(10), || shown.told() == all).await,
        "{:?}",
        shown.told()
    );
    let workspace = format!("hive://{WORKSPACE}");
    assert_eq!(
        desk.viewed(),
        [
            json!(["view.open", [VIEW, workspace, sent(390, 844)]]),
            json!(["view.post", ["v1", { "type": "ready", "v": 1 }]]),
            json!(["view.post", ["v1", selected]]),
            json!(["view.screen", ["v1", sent(844, 390)]]),
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn across_the_background_a_view_is_opened_again_on_the_newest_screen_and_starts_again_what_its_page_of_before_posted_dropped(
) {
    let desk = Desk::start(62).await;
    let phone = paired_with(&tmp("viewing-again"), &desk);
    let connections = Connections::new(phone.clone(), || {});
    connections.foreground();
    let shown = Arc::new(Shown::default());
    let viewing = Viewing::start(
        &connections,
        &desk.id,
        WORKSPACE,
        VIEW,
        screen(390, 844),
        shown.clone(),
    );
    viewing.post(READY);
    assert!(
        until(Duration::from_secs(10), || shown.told()
            == [hello(390, 844)])
        .await
    );

    // In the background its connection closes; the page shown still posts, and the phone turns.
    connections.background();
    assert!(until(Duration::from_secs(10), || desk.closed.load(SeqCst) == 1).await);
    viewing.post(r#"{"type":"command","name":"stale"}"#);
    viewing.screen(screen(844, 390));
    connections.foreground();
    let restarted = [hello(390, 844), Told::Ended(Ended::Restarting)];
    assert!(
        until(Duration::from_secs(10), || shown.told() == restarted).await,
        "{:?}",
        shown.told()
    );
    // Its page loaded anew, it is ready again.
    viewing.post(READY);
    viewing.post(r#"{"type":"command","name":"fresh"}"#);
    let fresh = json!({ "type": "command", "name": "fresh" });
    let echoed = Told::Said(json!({ "type": "echo", "of": fresh }));
    let all = [restarted.to_vec(), vec![hello(844, 390), echoed]].concat();
    assert!(
        until(Duration::from_secs(10), || shown.told() == all).await,
        "{:?}",
        shown.told()
    );
    let workspace = format!("hive://{WORKSPACE}");
    assert_eq!(
        desk.viewed()[2..],
        [
            json!(["view.open", [VIEW, workspace, sent(844, 390)]]),
            json!(["view.post", ["v2", { "type": "ready", "v": 1 }]]),
            json!(["view.post", ["v2", fresh]]),
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_view_ends_told_why_once_when_its_host_disables_it_or_the_device_refuses_it_or_holds_its_workspace_no_more(
) {
    let desk = Desk::start(63).await;
    let phone = paired_with(&tmp("viewing-ended"), &desk);
    let connections = Connections::new(phone.clone(), || {});
    connections.foreground();
    let cases = [
        (
            WORKSPACE,
            VIEW,
            Some(r#"{"type":"flood"}"#),
            Ended::Disabled(FLOODED.into()),
        ),
        (
            WORKSPACE,
            "desk-only",
            None,
            Ended::Lost(Lost::Refused(
                "no view desk-only here works on a phone".into(),
            )),
        ),
        (
            "w9",
            VIEW,
            None,
            Ended::Lost(Lost::NotHeld(
                "desk does not hold that workspace now".into(),
            )),
        ),
    ];
    for (workspace, view, post, why) in cases {
        let shown = Arc::new(Shown::default());
        let viewing = Viewing::start(
            &connections,
            &desk.id,
            workspace,
            view,
            screen(390, 844),
            shown.clone(),
        );
        if let Some(post) = post {
            viewing.post(post);
        }
        let ended = |told: &[Told]| told.iter().any(|t| matches!(t, Told::Ended(_)));
        assert!(until(Duration::from_secs(10), || ended(&shown.told())).await);
        // Nothing more: not opened again.
        viewing.post(READY);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(shown.told(), [Told::Ended(why)], "{view} on {workspace}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_view_stopped_tells_nothing_more_and_the_device_lets_go_of_it() {
    let desk = Desk::start(64).await;
    let phone = paired_with(&tmp("viewing-stopped"), &desk);
    let connections = Connections::new(phone.clone(), || {});
    connections.foreground();
    let shown = Arc::new(Shown::default());
    let viewing = Viewing::start(
        &connections,
        &desk.id,
        WORKSPACE,
        VIEW,
        screen(390, 844),
        shown.clone(),
    );
    viewing.post(READY);
    assert!(
        until(Duration::from_secs(10), || shown.told()
            == [hello(390, 844)])
        .await
    );
    let left = desk.left.load(SeqCst);
    viewing.stop();
    assert!(until(Duration::from_secs(10), || desk.left.load(SeqCst) > left).await);
    viewing.post(r#"{"type":"command","name":"late"}"#);
    viewing.screen(screen(844, 390));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(shown.told(), [hello(390, 844)]);
    assert_eq!(desk.viewed().len(), 2, "{:?}", desk.viewed());
}
