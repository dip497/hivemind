//! A community view shown on the phone (viewing.rs, views.rs; docs/design/phone-app-2026-10-02.md
//! §6.1; spec/workspace-api.md "Views on a remote screen", 0.14): its files come with the policy
//! to serve them under, and one that comes with none is not served; opened on the device that
//! holds its workspace, on the phone's screen; what it posts goes to its host there, but what is not
//! JSON; what its host says comes back, in order; the screen told as it changes; and a screen that
//! places the view's live surfaces itself says so, and takes the rects a page posts as the view
//! SDK does (conformance/view-surfaces.json). Across a dropped
//! connection and the background it is opened again on the newest screen, told to start again,
//! and what the page of before posted until the view is ready again is dropped. It ends, told why
//! once, when its host disables it, the device refuses it or holds its workspace no more; stopped,
//! it tells nothing more and the device lets go of it. What a page posts that starts or closes
//! something on the board asks the phone's lock first, held to conformance/view-commands.json.

mod support;

use std::{
    collections::BTreeMap,
    sync::{atomic::Ordering::SeqCst, Arc, Mutex},
    time::Duration,
};

use hive_phone::{
    connections::Connections,
    failure::Lost,
    viewing::{asks_lock, surfaces, Ended, Viewer, Viewing},
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
        false,
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
        false,
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
            false,
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
        false,
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_phone_that_places_a_views_live_surfaces_itself_says_so_each_time_it_opens_it() {
    let desk = Desk::start(65).await;
    let phone = paired_with(&tmp("viewing-surfaces"), &desk);
    let connections = Connections::new(phone.clone(), || {});
    connections.foreground();
    let shown = Arc::new(Shown::default());
    let viewing = Viewing::start(
        &connections,
        &desk.id,
        WORKSPACE,
        VIEW,
        screen(390, 844),
        true,
        shown.clone(),
    );
    viewing.post(READY);
    assert!(
        until(Duration::from_secs(10), || shown.told()
            == [hello(390, 844)])
        .await
    );
    // Opened again on the next connection, it says so again.
    connections.background();
    assert!(until(Duration::from_secs(10), || desk.closed.load(SeqCst) == 1).await);
    connections.foreground();
    let restarted = [hello(390, 844), Told::Ended(Ended::Restarting)];
    assert!(
        until(Duration::from_secs(10), || shown.told() == restarted).await,
        "{:?}",
        shown.told()
    );
    let opened: Vec<Value> = desk
        .viewed()
        .into_iter()
        .filter(|m| m[0] == "view.open")
        .collect();
    let workspace = format!("hive://{WORKSPACE}");
    let with_surfaces = json!(["view.open", [VIEW, workspace, sent(390, 844), true]]);
    assert_eq!(opened, [with_surfaces.clone(), with_surfaces]);
}

#[test]
fn what_a_page_posts_asks_the_phones_lock_when_it_starts_or_closes_something_on_the_board() {
    let cases: Value =
        serde_json::from_str(include_str!("../../../conformance/view-commands.json")).unwrap();
    for case in cases["posted"].as_array().unwrap() {
        let text = case["text"].as_str().unwrap();
        let expected = case["asksLock"].as_bool().unwrap();
        assert_eq!(asks_lock(text), expected, "{text}: {}", case["why"]);
    }
    // Every command the protocol has: the lock asked for each that needs `workspace:spawn` or
    // `workspace:close`, and for no other.
    for (name, permission) in cases["commands"].as_object().unwrap() {
        let command = json!({ "type": "command", "name": name, "args": [] }).to_string();
        let starts_or_closes = matches!(
            permission.as_str(),
            Some("workspace:spawn" | "workspace:close")
        );
        assert_eq!(
            asks_lock(&command),
            starts_or_closes,
            "{name}: {permission}"
        );
    }
}

#[test]
fn the_surfaces_a_page_asks_for_are_taken_as_the_view_sdk_takes_them() {
    let cases: Value =
        serde_json::from_str(include_str!("../../../conformance/view-surfaces.json")).unwrap();
    for case in cases["posted"].as_array().unwrap() {
        let text = case["text"].as_str().unwrap();
        let taken = surfaces(text).map(|placed| {
            let placed = placed.into_iter().map(
                |s| json!({ "tile": s.tile, "x": s.x, "y": s.y, "w": s.w, "h": s.h, "bar": s.bar }),
            );
            placed.collect::<Vec<_>>()
        });
        let expected = case["surfaces"].as_array().map(|all| all.to_vec());
        assert_eq!(taken.map(normal), expected.map(normal), "{}", case["why"]);
    }
}

/// Numbers as JSON has them: 12 and 12.0 alike.
fn normal(surfaces: Vec<Value>) -> Vec<Value> {
    let number = |v: &Value| json!(v.as_f64().unwrap());
    let normal = surfaces.iter().map(|s| {
        json!({ "tile": s["tile"], "x": number(&s["x"]), "y": number(&s["y"]),
                "w": number(&s["w"]), "h": number(&s["h"]), "bar": s["bar"] })
    });
    normal.collect()
}
