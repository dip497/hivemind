//! Home (spec/home.md), held to conformance/home.json's cases for a phone: what the computer sends
//! on the `home` stream taken in, in order; how far each sequence is followed; the rows held, read
//! as the agent list is read; and how they are shown: what waits on the person, what is at work,
//! the pinned, and the tree of machines, projects, frames and tiles, each tile with its last line.
//! A computer's side is held to the same file in packages/host.

use std::collections::BTreeMap;

use hive_phone::home::{Entry, Home, HomeView};
use serde_json::{json, Value};

/// The tree as the cases say it: a heading by its key, a frame or a tile by its key and depth.
fn said(entries: &[Entry]) -> Vec<String> {
    entries
        .iter()
        .map(|e| match e {
            Entry::Machine { key, .. } | Entry::Section { key, .. } => key.clone(),
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
                &HomeView::default(),
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

/// A view with `key` folded and nothing else chosen.
fn folding(key: &str) -> HomeView {
    HomeView {
        folded: vec![key.to_string()],
        ..HomeView::default()
    }
}

/// The first phone case's Home, taken in whole.
fn whole_case() -> (Home, String) {
    let cases: Value =
        serde_json::from_str(include_str!("../../../conformance/home.json")).unwrap();
    let c = &cases["phone"][0];
    let mut home = Home::default();
    for m in c["messages"].as_array().unwrap() {
        home.apply(m);
    }
    (home, c["computer"].as_str().unwrap().to_string())
}

#[test]
fn a_project_or_frame_says_how_many_rows_are_one_level_under_it_and_what_wants_a_look_and_folded_lists_nothing_under_it_unless_searched(
) {
    let (home, computer) = whole_case();
    let f1 = "f:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/f1".to_string();
    let project = "p:desk/a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/".to_string();
    let summary = |tree: &[Entry], key: &str| {
        tree.iter().find_map(|e| match e {
            Entry::Project {
                key: k,
                count,
                state,
                folded,
                ..
            }
            | Entry::Frame {
                key: k,
                count,
                state,
                folded,
                ..
            } if k == key => Some((*count, state.clone(), *folded)),
            _ => None,
        })
    };
    let open = home.shown("", None, &computer, &HomeView::default());
    // f1: t1 (waiting) and t2, and the frame f2 (t3 working); t6 is under t1, a level further.
    assert_eq!(
        summary(&open.tree, &f1),
        Some((3, Some("waiting".into()), false))
    );
    assert_eq!(
        summary(&open.tree, "f:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/f2"),
        Some((1, Some("working".into()), false))
    );
    assert_eq!(
        summary(&open.tree, "f:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/f0"),
        Some((0, None, false))
    );
    // The project: its frames f1 and f0, and t4 and t10, in no frame there.
    assert_eq!(
        summary(&open.tree, &project),
        Some((4, Some("waiting".into()), false))
    );

    let keys = |tree: &[Entry]| tree.iter().map(|e| e.key().to_string()).collect::<Vec<_>>();
    let frame_folded = home.shown("", None, &computer, &folding(&f1));
    let mut expected = keys(&open.tree);
    expected.retain(|k| {
        ![
            "t:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/t1",
            "t:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/t6",
            "t:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/t2",
            "f:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/f2",
            "t:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/t3",
        ]
        .contains(&k.as_str())
    });
    assert_eq!(keys(&frame_folded.tree), expected);
    assert_eq!(
        summary(&frame_folded.tree, &f1),
        Some((3, Some("waiting".into()), true))
    );

    let project_folded = home.shown("", None, &computer, &folding(&project));
    let at = keys(&project_folded.tree);
    let p = at.iter().position(|k| *k == project).unwrap();
    assert_eq!(
        at[p + 1],
        "p:desk/a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/web",
        "nothing under it"
    );

    let searched = home.shown("claude", None, &computer, &folding(&f1));
    assert!(keys(&searched.tree).contains(&"t:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/t1".to_string()));
    assert_eq!(
        keys(&searched.tree),
        keys(
            &home
                .shown("claude", None, &computer, &HomeView::default())
                .tree
        ),
        "a search shows every tile it finds"
    );
}

#[test]
fn home_carries_once_the_mark_of_each_agent_a_tile_listed_runs_as_absolute_paths_moved_as_its_shapes_say_in_their_colours(
) {
    let (mut home, computer) = whole_case();
    let seq = home.at.unwrap().layout;
    let icon = json!({
        "viewBox": "0 0 24 24",
        "attrs": { "fill": "currentColor", "fillRule": "evenodd" },
        "shapes": [
            { "path": { "d": "m2 2h4a2 2 0 0 1 2 2z" } },
            { "circle": { "cx": 12, "cy": 12, "r": "2", "transform": "translate(1 2) scale(2)", "fill": "none", "stroke": "currentColor", "stroke-width": "1.5" } },
            { "rect": { "x": 1, "y": 1, "width": 4, "height": 4, "fill": "#D97757", "stroke": "#00f" } },
        ],
    });
    assert!(home.apply(&json!({
        "t": "changes",
        "layout": { "seq": seq + 1, "changes": [
            { "seq": seq + 1, "key": "a:claude", "row": { "of": "agent", "id": "claude", "label": "Claude Code", "icon": icon } },
            { "seq": seq + 1, "key": "a:amp", "row": { "of": "agent", "id": "amp", "label": "Amp", "icon": icon } },
        ] },
    })));
    let shown = home.shown("", None, &computer, &HomeView::default());
    // codex runs on a tile but has no row; amp has a row but no tile runs it.
    assert_eq!(shown.marks.keys().collect::<Vec<_>>(), ["claude"]);
    let mark = &shown.marks["claude"];
    assert_eq!(
        (mark.x, mark.y, mark.width, mark.height),
        (0.0, 0.0, 24.0, 24.0)
    );
    let [path, ring, logo] = mark.shapes.as_slice() else {
        panic!("{mark:?}")
    };
    // The arc is a curve; relative moves are absolute.
    assert!(path.d.starts_with("M2 2L6 2C"), "{}", path.d);
    assert!(path.d.ends_with("8 4Z"), "{}", path.d);
    assert!(
        path.d
            .chars()
            .all(|c| !c.is_ascii_alphabetic() || "MLCQZ".contains(c)),
        "{}",
        path.d
    );
    assert_eq!((path.fill, path.even_odd, path.stroke), (true, true, 0.0));
    // Scaled by 2 about the origin, then moved by (1, 2): its left point (10, 12) is at (21, 26).
    assert!(ring.d.starts_with("M21 26"), "{}", ring.d);
    assert_eq!((ring.fill, ring.stroke), (false, 3.0));
    // A shape in the brand's own colour keeps it; one in the row's colour says none.
    assert_eq!((&path.fill_color, &ring.stroke_color), (&None, &None));
    assert_eq!(
        (logo.fill_color.as_deref(), logo.stroke_color.as_deref()),
        (Some("#d97757"), Some("#0000ff"))
    );
    let searched = home.shown("zzz-nothing", None, &computer, &HomeView::default());
    assert!(searched.marks.is_empty(), "no tile listed, no mark");
}

#[test]
fn the_view_menus_choices_filter_group_and_order_home_as_the_desktop_does() {
    let (home, computer) = whole_case();
    let chose = |status: &str, group_by: &str, sort_by: &str| HomeView {
        prefs: serde_json::from_value(
            json!({ "status": status, "activity": "all", "groupBy": group_by, "sortBy": sort_by }),
        )
        .unwrap(),
        ..HomeView::default()
    };
    let said = |v: &HomeView| {
        home.shown("", None, &computer, v)
            .tree
            .iter()
            .map(|e| match e {
                Entry::Section { key, count, .. } => format!("{key} {count}"),
                Entry::Tile {
                    key, depth, unread, ..
                } => {
                    format!(
                        "{} {depth}{}",
                        key.rsplit('/').next().unwrap(),
                        if *unread { " unread" } else { "" }
                    )
                }
                other => other.key().to_string(),
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(
        said(&chose("needs-you", "group", "canvas")),
        [
            "p:desk/a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/",
            "f:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/f1",
            "t1 1",
            "p:desk/z9z9z9z9z9z9z9z9z9z9z9z9z9z9z9z9/",
            "u1 0",
        ],
        "only what waits on the person; a frame left with none is not listed"
    );
    assert_eq!(
        said(&chose("all", "status", "canvas")),
        [
            "s:needs-you 2",
            "t1 0",
            "u1 0",
            "s:working 2",
            "t3 0",
            "t6 0",
            "s:idle 5",
            "t2 0",
            "t4 0",
            "t7 0",
            "t8 0",
            "t10 0"
        ],
        "a heading each, in the desktop's order, each tile once; the pinned are not here"
    );
    let names = |v: &HomeView| {
        home.shown("", None, &computer, v)
            .tree
            .iter()
            .filter_map(|e| match e {
                Entry::Tile { tile, depth: 0, .. } => Some(tile.name.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    let by_name = names(&chose("all", "none", "name"));
    let mut sorted = by_name.clone();
    sorted.sort_by(|a, b| hive_phone::layers::by_name(a, b));
    assert_eq!(by_name, sorted);
    assert_ne!(
        by_name,
        names(&chose("all", "none", "canvas")),
        "the case's names are not already in order"
    );
    let mut opened = chose("all", "none", "canvas");
    opened
        .seen
        .insert("t:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/t1".into(), 1);
    opened
        .seen
        .insert("t:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/t3".into(), 1);
    let unread: Vec<String> = said(&opened)
        .into_iter()
        .filter(|l| l.ends_with("unread"))
        .collect();
    assert_eq!(
        unread,
        ["t1 0 unread"],
        "t3 changed after too, but works still; the rest were never opened here"
    );
    opened.prefs.status = "unread".into();
    assert_eq!(said(&opened), ["s:all 1", "t1 0 unread"]);
}

#[test]
fn sorted_by_name_or_activity_a_frames_tiles_come_in_that_order_in_the_tree() {
    let mut home = Home::default();
    let tile = |id: &str, name: &str, order: u64, since: u64| {
        json!({ "of": "tile", "workspace": "w", "id": id, "frameId": "f", "kind": "claude", "name": name,
                "agent": "claude", "terminal": true, "order": order, "state": "idle", "since": since })
    };
    assert!(home.apply(&json!({
        "t": "home",
        "layout": { "seq": 1, "rows": [
            ["w:w", { "of": "workspace", "workspace": "w", "name": "api" }],
            ["f:w/f", { "of": "frame", "workspace": "w", "id": "f", "title": "work", "color": "#888", "order": 0 }],
            ["t:w/x1", tile("x1", "Zed", 0, 5)],
            ["t:w/x2", tile("x2", "Alpha", 1, 9)],
            ["t:w/x3", tile("x3", "Mid", 2, 1)],
        ] },
        "lines": { "seq": 0, "rows": [] },
    })));
    let order = |sort_by: &str| {
        let v = HomeView {
            prefs: serde_json::from_value(json!({ "status": "all", "activity": "all", "groupBy": "group", "sortBy": sort_by })).unwrap(),
            ..HomeView::default()
        };
        home.shown("", None, "desk", &v)
            .tree
            .iter()
            .filter_map(|e| match e {
                Entry::Tile { tile, .. } => Some(tile.name.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(order("canvas"), ["Zed", "Alpha", "Mid"]);
    assert_eq!(order("name"), ["Alpha", "Mid", "Zed"]);
    assert_eq!(order("activity"), ["Alpha", "Zed", "Mid"]);
}

/// How a computer looks, as Home 0.5 sends it.
fn look(bg: &str, mode: &str) -> Value {
    json!({
        "mode": mode,
        "colors": { "bg": bg, "fg": "#eeeeee", "brand": "#5b6cff" },
        "terminal": { "background": bg, "foreground": "#eeeeee", "cursor": "#eeeeee", "selection": "#333333",
            "ansi": vec!["#101010"; 16] },
        "wallpaper": { "kind": "@dip497/live-scenes/koi", "colour": true, "brightness": 85, "motion": true, "glass": 72 }
    })
}

#[test]
fn the_look_is_held_from_the_whole_and_from_a_change_kept_with_the_rest_and_one_that_is_not_hex_is_not_taken(
) {
    let whole = |look: Value| json!({ "t": "home", "layout": { "seq": 1, "rows": [] }, "lines": { "seq": 0, "rows": [] }, "look": look });
    let mut home = Home::default();
    assert!(home.apply(&whole(look("#101820", "dark"))));
    let held = home.look.clone().unwrap();
    assert_eq!(
        (
            held.mode.as_str(),
            held.colors["bg"].as_str(),
            held.wallpaper.kind.as_str()
        ),
        ("dark", "#101820", "@dip497/live-scenes/koi")
    );

    // Recoloured: a change that carries only the look.
    assert!(home.apply(&json!({ "t": "changes", "look": look("#fafafa", "light") })));
    assert_eq!(home.look.as_ref().unwrap().mode, "light");
    // The same look again changes nothing.
    assert!(!home.apply(&json!({ "t": "changes", "look": look("#fafafa", "light") })));

    // Kept, it comes back with the rows.
    let kept: Home = serde_json::from_value(serde_json::to_value(&home).unwrap()).unwrap();
    assert_eq!(kept.look, home.look);

    // A colour that is not `#rrggbb`, a mode it does not know, or too few terminal colours: not taken.
    let mut bad = look("url(x)", "dark");
    assert!(!home.apply(&json!({ "t": "changes", "look": bad.clone() })));
    bad = look("#000000", "dusk");
    assert!(!home.apply(&json!({ "t": "changes", "look": bad })));
    let mut short = look("#000000", "dark");
    short["terminal"]["ansi"] = json!(["#000000"]);
    assert!(!home.apply(&json!({ "t": "changes", "look": short })));
    assert_eq!(home.look.as_ref().unwrap().colors["bg"], "#fafafa");
    // A photo named by its revision is taken; one named by anything else, or a wallpaper that is
    // not a word nor a package's, is not.
    let mut photo = look("#fafafa", "light");
    photo["wallpaper"]["kind"] = json!("image");
    photo["wallpaper"]["media"] = json!({ "revision": "0123456789abcdef", "type": "image" });
    assert!(home.apply(&json!({ "t": "changes", "look": photo.clone() })));
    assert_eq!(
        home.look
            .as_ref()
            .unwrap()
            .wallpaper
            .media
            .as_ref()
            .unwrap()
            .revision,
        "0123456789abcdef"
    );
    photo["wallpaper"]["media"]["revision"] = json!("hivemedia://media/x.png");
    assert!(!home.apply(&json!({ "t": "changes", "look": photo })));
    let mut far = look("#fafafa", "light");
    far["wallpaper"]["kind"] = json!("../../etc");
    assert!(!home.apply(&json!({ "t": "changes", "look": far })));
    // A token it cannot read is left out; the rest is taken.
    let mut odd = look("#123456", "dark");
    odd["colors"]["bg2"] = json!("red");
    assert!(home.apply(&json!({ "t": "changes", "look": odd })));
    assert!(!home.look.as_ref().unwrap().colors.contains_key("bg2"));
}
