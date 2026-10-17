//! The phone's connections to the person's devices (connections.rs; docs/design/phone-app-
//! 2026-10-02.md §3.2): nothing is dialled before the foreground; in it, each device is reached and
//! kept, what it says is kept, and whose devices these are as its app says; a call goes out on the
//! connection kept, and only in a workspace the device holds; in the background the connection is
//! closed, and back in the foreground the device is reached again; a device gone is found away. A
//! device that lists its agents is followed, each list kept as it comes, and the workspaces it
//! holds; one that does not is asked what waits on the person. A device unpaired is told,
//! forgotten, and its connection closed. Which device holds a workspace is asked of all at once,
//! for as long as given and no longer.

mod support;

use std::{
    sync::{
        atomic::{AtomicUsize, Ordering::SeqCst},
        Arc,
    },
    time::{Duration, Instant},
};

use hive_phone::{connections::Connections, needs::Heard, workspace::Held};
use serde_json::{json, Value};
use support::{paired_also, paired_with, tmp, until, Desk, TILE, WORKSPACE};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_device_is_kept_reached_in_the_foreground_closed_in_the_background_and_found_away_once_gone(
) {
    let desk = Desk::start(21).await;
    let phone = paired_with(&tmp("foreground"), &desk);
    let changes = Arc::new(AtomicUsize::new(0));
    let changed = changes.clone();
    let connections = Connections::new(phone.clone(), move || {
        changed.fetch_add(1, SeqCst);
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(desk.dialled.load(SeqCst), 0);
    assert!(!connections.seen()[0].reachable);

    connections.foreground();
    // Once it said what waits there: it may tell the workspaces it holds first.
    let reached = || {
        let seen = &connections.seen()[0];
        seen.reachable && seen.heard.as_ref().is_some_and(|h| h.answer.is_some())
    };
    assert!(until(Duration::from_secs(10), reached).await);
    let heard = connections.seen().remove(0).heard.unwrap().answer.unwrap();
    assert_eq!(
        (heard.working, heard.needs[0].agent.as_str()),
        (1, "Editing Nav.tsx")
    );
    assert_eq!(phone.person().map(|p| p.name), Some("Priya".into()));
    assert!(changes.load(SeqCst) > 0);

    // A call goes out on the connection kept, and opens no workspace the device does not hold.
    connections.holding(&desk.id, WORKSPACE).await.unwrap();
    assert!(connections.holding(&desk.id, "elsewhere").await.is_err());
    assert_eq!(desk.dialled.load(SeqCst), 1);

    connections.background();
    assert!(until(Duration::from_secs(5), || desk.closed.load(SeqCst) == 1).await);
    assert!(until(Duration::from_secs(5), || !connections.seen()[0].reachable).await);
    connections.foreground();
    assert!(until(Duration::from_secs(5), || connections.seen()[0].reachable).await);
    assert_eq!(desk.dialled.load(SeqCst), 2);

    // Gone once it said all it says on being reached: dialled again, and not reached.
    assert!(until(Duration::from_secs(5), || desk.answered.load(SeqCst) == 2).await);
    tokio::time::sleep(Duration::from_millis(200)).await;
    desk.stop().await;
    let away = || {
        let seen = &connections.seen()[0];
        !seen.reachable && seen.away_since.is_some()
    };
    assert!(
        until(Duration::from_secs(30), away).await,
        "never found away"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_device_that_lists_its_agents_is_followed_each_list_kept_as_it_comes_with_the_workspaces_it_holds(
) {
    let desk = Desk::start(23).await;
    let agent = |tile: &str, state: &str, waiting: Value| {
        json!({ "workspace": WORKSPACE, "name": "api", "tile": tile, "agent": "Editing Nav.tsx",
            "state": state, "since": 5, "machine": "desk", "waiting": waiting })
    };
    let permission = json!({ "kind": "permission", "since": 5, "decide": true });
    let list = |working: u64, agents: Vec<Value>| {
        Some(json!({ "t": "agents", "agents": agents, "working": working }))
    };
    desk.agents.send_replace(list(
        1,
        vec![
            agent(TILE, "waiting", permission),
            agent("t2", "working", Value::Null),
        ],
    ));
    let phone = paired_with(&tmp("listed"), &desk);
    let connections = Connections::new(phone.clone(), || {});
    connections.foreground();
    let heard = || connections.seen().remove(0).heard;
    let states = |heard: Option<Heard>| -> Vec<(String, String)> {
        let agents = heard.and_then(|heard| heard.agents).unwrap_or_default();
        agents.into_iter().map(|a| (a.tile, a.state)).collect()
    };
    let state = |tile: &str, state: &str| (tile.to_string(), state.to_string());
    let first = [state(TILE, "waiting"), state("t2", "working")];
    assert!(until(Duration::from_secs(10), || states(heard()) == first).await);
    let kept = heard().unwrap();
    let api = Held {
        workspace: WORKSPACE.into(),
        name: "api".into(),
        folder: Some("/home/priya/api".into()),
    };
    assert_eq!(kept.workspaces, [api]);

    // Its agents change: the new list is kept in place of the last, as it comes.
    desk.agents.send_replace(list(
        2,
        vec![
            agent(TILE, "working", Value::Null),
            agent("t2", "working", Value::Null),
        ],
    ));
    let next = [state(TILE, "working"), state("t2", "working")];
    assert!(until(Duration::from_secs(10), || states(heard()) == next).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_device_unpaired_is_told_forgotten_and_its_connection_closed() {
    let desk = Desk::start(22).await;
    let phone = paired_with(&tmp("unpaired"), &desk);
    let connections = Connections::new(phone.clone(), || {});
    connections.foreground();
    assert!(until(Duration::from_secs(10), || connections.seen()[0].reachable).await);
    let endpoint = connections.endpoint().await.unwrap();
    let unpaired = phone.unpair_from(&endpoint, &desk.id).await.unwrap();
    connections.devices_changed();
    assert!(unpaired.told);
    assert!(connections.seen().is_empty());
    // The call's own connection, and the one kept.
    assert!(until(Duration::from_secs(5), || desk.closed.load(SeqCst) == 2).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn which_device_holds_a_workspace_is_the_first_to_say_so_asked_all_at_once_and_none_once_the_time_given_is_up(
) {
    let desk = Desk::start(72).await;
    let dir = tmp("holder");
    let phone = paired_with(&dir, &desk);
    // Another of Priya's computers, never reached: asking it waits on nothing. Paired with the
    // desk again, the desk is listed after it, and asked after it were they asked one by one.
    paired_also(&phone, 73, "attic", "203.0.113.7:4433");
    let phone = paired_with(&dir, &desk);
    let listed: Vec<String> = phone.devices().into_iter().map(|d| d.with.name).collect();
    assert_eq!(listed, ["attic", "desk"]);
    let connections = Connections::new(phone.clone(), || {});
    let within = Duration::from_secs(2);
    let began = Instant::now();
    assert_eq!(
        connections.holder_of(WORKSPACE, within).await,
        Some(desk.id.clone())
    );
    assert!(began.elapsed() < within, "the desk answered at once");
    assert_eq!(connections.holder_of("w9", within).await, None);
    // Not the time a device has to answer: a push handler has seconds.
    assert!(began.elapsed() < 2 * within, "{:?}", began.elapsed());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn someone_asking_to_join_is_let_in_or_turned_away_on_the_device_that_asked_once() {
    let desk = Desk::start(29).await;
    let phone = paired_with(&tmp("let-in"), &desk);
    let connections = Connections::new(phone, || {});
    connections.foreground();
    let connection = connections.holding(&desk.id, WORKSPACE).await.unwrap();
    assert!(
        hive_phone::workspace::let_in(&connection, WORKSPACE, 7, true)
            .await
            .unwrap()
    );
    assert!(
        !hive_phone::workspace::let_in(&connection, WORKSPACE, 8, false)
            .await
            .unwrap()
    );
    let told: Vec<Value> = desk
        .told
        .lock()
        .unwrap()
        .iter()
        .map(|(_, m)| json!([m["method"], m["params"]]))
        .collect();
    let url = format!("hive://{WORKSPACE}");
    assert_eq!(
        told,
        vec![
            json!(["people.answer", [url, 7, true]]),
            json!(["people.answer", [url, 8, false]])
        ]
    );
}
