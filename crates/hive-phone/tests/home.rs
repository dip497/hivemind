//! Home (spec/home.md), held to conformance/home.json's cases for a phone: what the computer sends
//! on the `home` stream taken in, in order; how far each sequence is followed; the rows held, read
//! as the agent list is read; and how they are shown: what waits on the person, what is at work,
//! the pinned, and the tree of machines, projects, frames and tiles, each tile with its last line.
//! A computer's side is held to the same file in packages/host.

use std::collections::BTreeMap;

use hive_phone::home::{Entry, Home};
use serde_json::{json, Value};

/// The tree as the cases say it: a heading by its key, a frame or a tile by its key and depth.
fn said(entries: &[Entry]) -> Vec<String> {
    entries
        .iter()
        .map(|e| match e {
            Entry::Machine { key, .. } => key.clone(),
            Entry::Project { key, frame, .. } => match frame {
                Some(f) => format!("{key} {f}"),
                None => key.clone(),
            },
            Entry::Frame { key, depth, .. } | Entry::Tile { key, depth, .. } => {
                format!("{key} {depth}")
            }
        })
        .collect()
}

#[test]
fn home_is_followed_from_the_whole_and_each_change_after_it_and_shown_as_the_layers_panel_lists_it()
{
    let cases: Value =
        serde_json::from_str(include_str!("../../../conformance/home.json")).unwrap();
    let cases = cases["phone"].as_array().unwrap();
    assert!(!cases.is_empty());
    for c in cases {
        let about = c["about"].as_str().unwrap();
        let mut home = Home::default();
        for m in c["messages"].as_array().unwrap() {
            home.apply(m);
        }
        assert_eq!(serde_json::to_value(home.at).unwrap(), c["at"], "{about}");
        if let Some(held) = c.get("held") {
            assert_eq!(serde_json::to_value(&home.rows).unwrap(), *held, "{about}");
        }
        let queries = c
            .get("queries")
            .and_then(Value::as_array)
            .map_or(vec![""], |q| q.iter().filter_map(Value::as_str).collect());
        for query in queries {
            let shown = home.shown(
                query,
                c["machine"].as_str(),
                c["computer"].as_str().unwrap(),
            );
            let lines: BTreeMap<&str, &str> = shown
                .tree
                .iter()
                .filter_map(|e| match e {
                    Entry::Tile {
                        key, line: Some(l), ..
                    } => Some((key.as_str(), l.as_str())),
                    _ => None,
                })
                .collect();
            let keys = |l: &[Entry]| l.iter().map(|e| e.key().to_string()).collect::<Vec<_>>();
            assert_eq!(
                json!({
                    "needs": shown.needs,
                    "working": keys(&shown.working),
                    "pinned": keys(&shown.pinned),
                    "machines": shown.machines,
                    "tree": said(&shown.tree),
                    "said": lines,
                }),
                c["shown"],
                "{about}: {query:?}"
            );
        }
    }
}

#[test]
fn what_is_held_is_kept_and_followed_on_from_where_it_was() {
    let mut home = Home::default();
    assert!(
        !home.apply(&json!({ "t": "home", "layout": { "seq": 2 } })),
        "no lines: not taken"
    );
    assert_eq!(home.at, None);
    assert!(home.apply(&json!({
        "t": "home",
        "layout": { "seq": 2, "rows": [["w:a", { "of": "workspace", "workspace": "a", "name": "api" }]] },
        "lines": { "seq": 1, "rows": [] },
    })));
    let kept: Home = serde_json::from_value(serde_json::to_value(&home).unwrap()).unwrap();
    assert_eq!(kept, home);
    // Every kind of row, kept and read back.
    let cases: Value =
        serde_json::from_str(include_str!("../../../conformance/home.json")).unwrap();
    let mut whole = Home::default();
    for m in cases["phone"][0]["messages"].as_array().unwrap() {
        whole.apply(m);
    }
    assert_eq!(whole.rows.len(), 22);
    let kept: Home = serde_json::from_value(serde_json::to_value(&whole).unwrap()).unwrap();
    assert_eq!(kept, whole);
    assert!(
        !home.apply(&json!({ "t": "changes", "layout": { "seq": 2, "changes": [] } })),
        "nothing new"
    );
}
