//! Home over two computers as one (the browser page reaches each of the person's): what waits on
//! the person across both, the longest first; each tree under its computer's name; a status
//! grouping once across both.

use hive_phone::home::{Entry, Home, HomeView};
use hive_phone::homes::{self, Held};
use serde_json::{json, Value};

/// The first phone case of conformance/home.json: the computer "desk", two of whose agents wait.
fn desk() -> Home {
    let cases: Value =
        serde_json::from_str(include_str!("../../../conformance/home.json")).unwrap();
    let mut home = Home::default();
    for m in cases["phone"][0]["messages"].as_array().unwrap() {
        home.apply(m);
    }
    home
}

/// The computer "laptop": one workspace, one frame, one agent waiting since before any of desk's
/// and one at work.
fn laptop() -> Home {
    let mut home = Home::default();
    assert!(home.apply(&json!({
        "t": "home",
        "layout": { "seq": 1, "rows": [
            ["w:b2", { "of": "workspace", "workspace": "b2", "name": "notes" }],
            ["f:b2/n1", { "of": "frame", "workspace": "b2", "id": "n1", "title": "notes", "color": "#336699", "order": 0 }],
            ["t:b2/q1", { "of": "tile", "workspace": "b2", "id": "q1", "frameId": "n1", "kind": "claude", "name": "Ask first", "order": 0,
              "agent": "claude", "state": "waiting", "since": 1790000000500_u64,
              "waiting": { "kind": "question", "since": 1790000000500_u64 } }],
            ["t:b2/q2", { "of": "tile", "workspace": "b2", "id": "q2", "frameId": "n1", "kind": "claude", "name": "Busy", "order": 1,
              "agent": "claude", "state": "working", "since": 1790000002000_u64 }],
        ] },
        "lines": { "seq": 1, "rows": [] },
    })));
    home
}

fn keys(entries: &[Entry]) -> Vec<String> {
    entries.iter().map(|e| e.key().to_string()).collect()
}

#[test]
fn two_computers_show_as_one_home_the_longest_waiting_first_each_tree_under_its_computer() {
    let (desk, laptop) = (desk(), laptop());
    let both = [
        Held {
            device: "d1",
            computer: "desk",
            home: &desk,
        },
        Held {
            device: "d2",
            computer: "laptop",
            home: &laptop,
        },
    ];
    let shown = homes::shown(&both, "", None, &HomeView::default());
    let alone = desk.shown("", None, "desk", &HomeView::default());

    // Laptop's question waits longest, then desk's two in desk's own order.
    assert_eq!(shown.needs[0], "t:b2/q1");
    assert_eq!(shown.needs[1..], alone.needs[..]);
    // At work: desk's two and laptop's one, by when each started.
    let mut expected = keys(&alone.working);
    expected.push("t:b2/q2".into());
    let mut got = keys(&shown.working);
    expected.sort();
    got.sort();
    assert_eq!(got, expected);
    let starts: Vec<u64> = shown
        .working
        .iter()
        .filter_map(|e| match e {
            Entry::Tile { tile, .. } => tile.since,
            _ => None,
        })
        .collect();
    assert!(
        starts.windows(2).all(|w| w[0] <= w[1]),
        "longest at work first: {starts:?}"
    );

    // Desk's tree as it is (it heads its own machines), then laptop's under its name.
    let at = shown
        .tree
        .iter()
        .position(|e| e.key() == "m:laptop")
        .expect("laptop is headed");
    assert_eq!(keys(&shown.tree[..at]), keys(&alone.tree));
    assert_eq!(
        keys(&shown.tree[at + 1..]),
        ["p:laptop/b2/", "t:b2/q1", "t:b2/q2"]
    );
    // Every machine of both to choose from.
    assert_eq!(shown.machines, ["desk", "alpha", "box", "Zed", "laptop"]);

    // Laptop's machine chosen: desk shows nothing.
    let chosen = homes::shown(&both, "", Some("laptop"), &HomeView::default());
    assert_eq!(chosen.needs, ["t:b2/q1"]);
    assert!(chosen.tree.iter().all(|e| !e.key().contains("a1a1")));

    // And the agents of both as one list, each saying its computer.
    let all = homes::overview(&both);
    assert_eq!(all.needs[0].device, "d2");
    assert_eq!(all.needs.len(), 3);
}

#[test]
fn grouped_by_status_each_status_is_one_heading_across_both_computers() {
    let (desk, laptop) = (desk(), laptop());
    let view = HomeView {
        prefs: serde_json::from_value(
            json!({ "status": "all", "activity": "all", "groupBy": "status", "sortBy": "manual" }),
        )
        .unwrap(),
        ..HomeView::default()
    };
    let both = [
        Held {
            device: "d1",
            computer: "desk",
            home: &desk,
        },
        Held {
            device: "d2",
            computer: "laptop",
            home: &laptop,
        },
    ];
    let shown = homes::shown(&both, "", None, &view);
    let alone = desk.shown("", None, "desk", &view);
    let headings: Vec<(String, u32)> = shown
        .tree
        .iter()
        .filter_map(|e| match e {
            Entry::Section { key, count, .. } => Some((key.clone(), *count)),
            _ => None,
        })
        .collect();
    let unique: std::collections::HashSet<_> = headings.iter().map(|(k, _)| k).collect();
    assert_eq!(
        unique.len(),
        headings.len(),
        "each status once: {headings:?}"
    );
    let count = |tree: &[Entry], key: &str| {
        tree.iter().find_map(|e| match e {
            Entry::Section { key: k, count, .. } if k == key => Some(*count),
            _ => None,
        })
    };
    let needs = headings
        .iter()
        .find(|(k, _)| k == "s:needs-you")
        .expect("a needs-you heading")
        .0
        .clone();
    assert_eq!(
        count(&shown.tree, &needs),
        Some(count(&alone.tree, &needs).unwrap() + 1)
    );
    // Laptop's waiting agent is listed under it, once.
    assert_eq!(
        shown.tree.iter().filter(|e| e.key() == "t:b2/q1").count(),
        1
    );
}

#[test]
fn one_computer_shows_as_its_own_home_does() {
    let desk = desk();
    let one = [Held {
        device: "d1",
        computer: "desk",
        home: &desk,
    }];
    assert_eq!(
        homes::shown(&one, "", None, &HomeView::default()),
        desk.shown("", None, "desk", &HomeView::default())
    );
}
