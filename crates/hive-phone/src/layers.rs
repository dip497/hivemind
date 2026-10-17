//! What a list of tiles shows from the person's View choices, as the desktop's Layers panel shows
//! it (`packages/hive-core/src/layers.ts`, which owns these rules): the pinned on top, then the
//! rest the choices let through, grouped and ordered as they say. Both are held to
//! `conformance/layers.json`.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

/// A tile as the rules read it. `status` is its kind as `tile-status.ts` reads a status;
/// `activity` when that last changed (ms); `seen` when the person last looked at it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerTile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub frame_id: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
    pub status: String,
    pub needs_you: bool,
    #[serde(default)]
    pub activity: Option<u64>,
    pub machine: String,
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub seen: Option<u64>,
}

/// The View menu's choices: `status` all, needs-you, unread, working, idle or exited; `activity`
/// all, hour, today or week; `group_by` group, machine, date, status, agent or none; `sort_by`
/// canvas, activity or name; `machines` the computers kept (none: every one).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    pub status: String,
    pub activity: String,
    pub group_by: String,
    pub sort_by: String,
    #[serde(default)]
    pub machines: Vec<String>,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            status: "all".into(),
            activity: "all".into(),
            group_by: "group".into(),
            sort_by: "canvas".into(),
            machines: vec![],
        }
    }
}

/// A heading and its tiles (indexes into the tiles given), for the groupings that are not the tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bucket {
    pub key: String,
    pub label: String,
    pub tiles: Vec<usize>,
}

/// What the list shows, each tile an index into the tiles given.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct View {
    /// Pinned, in the order pinned: whatever the choices say, and nowhere else.
    pub pinned: Vec<usize>,
    /// Grouped by machine or group: the tree, with these tiles per frame, frames in the order a
    /// tile of each first comes.
    pub tree: bool,
    pub by_frame: Vec<(Option<String>, Vec<usize>)>,
    /// Any other grouping: its headings in order (one with no label for "none").
    pub buckets: Vec<Bucket>,
    /// The choices leave some tiles out: frames left with none are not listed.
    pub filtering: bool,
    /// The tiles listed under the one that started them, by its id, in list order. The lists
    /// above hold only tiles under no other.
    pub kids: Vec<(String, Vec<usize>)>,
}

const HOUR: u64 = 3_600_000;
const DAY: u64 = 24 * HOUR;

/// Done since the person last looked: of `status`, it changed (`activity`) after they saw it
/// (`seen`) and is not still at work.
pub fn is_unread(status: &str, activity: Option<u64>, seen: Option<u64>) -> bool {
    status != "working" && matches!((activity, seen), (Some(a), Some(s)) if a > s)
}

/// The start of the day `now` is in, where the clock is `offset` minutes ahead of UTC.
fn midnight(now: u64, offset: i64) -> u64 {
    let local = now as i64 + offset * 60_000;
    (local - local.rem_euclid(DAY as i64) - offset * 60_000).max(0) as u64
}

fn passes(t: &LayerTile, prefs: &Prefs, now: u64, offset: i64) -> bool {
    if !prefs.machines.is_empty() && !prefs.machines.contains(&t.machine) {
        return false;
    }
    let ok = match prefs.status.as_str() {
        "needs-you" => t.needs_you,
        "unread" => is_unread(&t.status, t.activity, t.seen),
        "working" => !t.needs_you && t.status == "working",
        "idle" => !t.needs_you && t.status == "idle",
        "exited" => t.status == "exited",
        _ => true,
    };
    if !ok {
        return false;
    }
    let since = match prefs.activity.as_str() {
        "hour" => now.saturating_sub(HOUR),
        "today" => midnight(now, offset),
        "week" => now.saturating_sub(7 * DAY),
        _ => return true,
    };
    t.activity.is_some_and(|a| a >= since)
}

/// Names compared as people read them: letters before case, and runs of digits by their value.
pub fn by_name(a: &str, b: &str) -> Ordering {
    fn chunks(s: &str) -> Vec<(bool, String)> {
        let mut out: Vec<(bool, String)> = vec![];
        for c in s.chars() {
            let digit = c.is_ascii_digit();
            match out.last_mut() {
                Some((d, run)) if *d == digit => run.push(c),
                _ => out.push((digit, c.to_string())),
            }
        }
        out
    }
    let (ca, cb) = (chunks(a), chunks(b));
    for (x, y) in ca.iter().zip(cb.iter()) {
        let o = match (x, y) {
            ((true, n), (true, m)) => {
                let (n, m) = (n.trim_start_matches('0'), m.trim_start_matches('0'));
                n.len().cmp(&m.len()).then_with(|| n.cmp(m))
            }
            ((_, s), (_, t)) => s.to_lowercase().cmp(&t.to_lowercase()),
        };
        if o != Ordering::Equal {
            return o;
        }
    }
    ca.len().cmp(&cb.len()).then_with(|| b.cmp(a)) // lower case first, as a locale compares
}

const STATUS_BUCKETS: [(&str, &str); 4] = [
    ("needs-you", "Needs you"),
    ("working", "Working"),
    ("exited", "Exited"),
    ("idle", "Idle"),
];

fn in_status_bucket(key: &str, t: &LayerTile) -> bool {
    match key {
        "needs-you" => t.needs_you,
        "working" => t.status == "working",
        "exited" => t.status == "exited",
        _ => true,
    }
}

fn date_bucket(t: &LayerTile, now: u64, offset: i64) -> (&'static str, &'static str) {
    let today = midnight(now, offset);
    match t.activity {
        Some(a) if a >= today => ("today", "Today"),
        Some(a) if a >= today.saturating_sub(DAY) => ("yesterday", "Yesterday"),
        Some(a) if a >= today.saturating_sub(6 * DAY) => ("week", "This week"),
        _ => ("older", "Older"),
    }
}
const DATE_ORDER: [&str; 4] = ["today", "yesterday", "week", "older"];

/// The view of `tiles` (in canvas order) for `prefs`: `pinned` ids in the order pinned, `query`
/// searched for (only the tiles whose name or agent holds it, pinned ones too), `agent_label`
/// naming a tile's agent or kind for grouping by agent, the clock `offset` minutes ahead of UTC.
pub fn view(
    tiles: &[LayerTile],
    pinned: &[String],
    prefs: &Prefs,
    now: u64,
    offset: i64,
    agent_label: &dyn Fn(&LayerTile) -> String,
    query: &str,
) -> View {
    let q = query.trim().to_lowercase();
    let found = |t: &LayerTile| {
        q.is_empty()
            || format!("{} {}", t.name, agent_label(t))
                .to_lowercase()
                .contains(&q)
    };
    let at: HashMap<&str, usize> = tiles
        .iter()
        .enumerate()
        .map(|(i, t)| (t.id.as_str(), i))
        .collect();
    let pinned_set: HashSet<&str> = pinned.iter().map(String::as_str).collect();
    let pinned_list: Vec<usize> = pinned
        .iter()
        .filter_map(|id| at.get(id.as_str()).copied())
        .filter(|&i| found(&tiles[i]))
        .collect();
    let mut rest: Vec<usize> = (0..tiles.len())
        .filter(|&i| {
            let t = &tiles[i];
            !pinned_set.contains(t.id.as_str()) && found(t) && passes(t, prefs, now, offset)
        })
        .collect();
    match prefs.sort_by.as_str() {
        "name" => rest.sort_by(|&a, &b| by_name(&tiles[a].name, &tiles[b].name)),
        "activity" => rest.sort_by(|&a, &b| {
            let n = |i: usize| tiles[i].activity.map_or(-1, |a| a as i128);
            n(b).cmp(&n(a))
        }),
        _ => {}
    }
    let filtering = !q.is_empty()
        || prefs.status != "all"
        || prefs.activity != "all"
        || !prefs.machines.is_empty();
    let tree = prefs.group_by == "machine" || prefs.group_by == "group";
    let mut by_frame: Vec<(Option<String>, Vec<usize>)> = vec![];
    let mut buckets: Vec<Bucket> = vec![];
    if tree {
        for &i in &rest {
            let frame = tiles[i].frame_id.clone();
            match by_frame.iter_mut().find(|(f, _)| *f == frame) {
                Some((_, list)) => list.push(i),
                None => by_frame.push((frame, vec![i])),
            }
        }
    } else if prefs.group_by == "none" {
        if !rest.is_empty() {
            buckets.push(Bucket {
                key: "all".into(),
                label: String::new(),
                tiles: rest.clone(),
            });
        }
    } else if prefs.group_by == "status" {
        let mut left: Vec<usize> = rest.clone();
        for (key, label) in STATUS_BUCKETS {
            let (here, other): (Vec<usize>, Vec<usize>) = left
                .iter()
                .partition(|&&i| in_status_bucket(key, &tiles[i]));
            left = other;
            if !here.is_empty() {
                buckets.push(Bucket {
                    key: key.into(),
                    label: label.into(),
                    tiles: here,
                });
            }
        }
    } else {
        for &i in &rest {
            let (key, label) = if prefs.group_by == "date" {
                let (k, l) = date_bucket(&tiles[i], now, offset);
                (k.to_string(), l.to_string())
            } else {
                let l = agent_label(&tiles[i]);
                (l.to_lowercase(), l)
            };
            match buckets.iter_mut().find(|b| b.key == key) {
                Some(b) => b.tiles.push(i),
                None => buckets.push(Bucket {
                    key,
                    label,
                    tiles: vec![i],
                }),
            }
        }
        if prefs.group_by == "date" {
            buckets.sort_by_key(|b| DATE_ORDER.iter().position(|k| *k == b.key));
        } else {
            buckets.sort_by(|a, b| by_name(&a.label, &b.label));
        }
    }
    let mut kids: Vec<(String, Vec<usize>)> = vec![];
    for (_, list) in &mut by_frame {
        *list = nest(tiles, list, &mut kids);
    }
    for b in &mut buckets {
        b.tiles = nest(tiles, &b.tiles, &mut kids);
    }
    View {
        pinned: pinned_list,
        tree,
        by_frame,
        buckets,
        filtering,
        kids,
    }
}

/// `list` without the tiles whose starter is in it too, which go into `kids` under it, in list
/// order. A tile whose starters loop back to it stays in the list, so no tile is ever lost.
fn nest(tiles: &[LayerTile], list: &[usize], kids: &mut Vec<(String, Vec<usize>)>) -> Vec<usize> {
    let here: HashMap<&str, usize> = list.iter().map(|&i| (tiles[i].id.as_str(), i)).collect();
    let under = |t: &LayerTile| -> bool {
        let mut seen = HashSet::from([t.id.as_str()]);
        let mut p = t.parent.as_deref();
        while let Some(id) = p {
            let Some(&i) = here.get(id) else { break };
            if !seen.insert(id) {
                return false;
            }
            p = tiles[i].parent.as_deref();
        }
        t.parent.as_deref().is_some_and(|p| here.contains_key(p))
    };
    let mut top = vec![];
    for &i in list {
        let t = &tiles[i];
        if !under(t) {
            top.push(i);
            continue;
        }
        let parent = t.parent.clone().unwrap_or_default();
        match kids.iter_mut().find(|(p, _)| *p == parent) {
            Some((_, k)) => k.push(i),
            None => kids.push((parent, vec![i])),
        }
    }
    top
}
