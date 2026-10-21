//! Home over several of the person's computers, as one: what waits on the person and what is at
//! work across all of them, the longest first; each computer's tree under its name; a grouping
//! that is not the tree (by status, date, agent) once across all of them.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::agents::{as_one, Listed, Overview};
use crate::home::{wants_look, Entry, Home, HomeView, Shown};

/// One computer's Home, by its id and what it is called.
pub struct Held<'a> {
    pub device: &'a str,
    pub computer: &'a str,
    pub home: &'a Home,
}

/// Every computer's agents as one list.
pub fn overview(homes: &[Held]) -> Overview {
    as_one(
        homes
            .iter()
            .map(|h| {
                let o = h.home.overview(h.device, h.computer);
                Listed {
                    agents: o.agents,
                    working: o.working,
                }
            })
            .collect(),
    )
}

/// Home as the phone shows it across `homes`, chosen as `Home::shown` chooses on each.
pub fn shown(homes: &[Held], query: &str, machine: Option<&str>, view: &HomeView) -> Shown {
    if let [one] = homes {
        return one.home.shown(query, machine, one.computer, view);
    }
    let each: Vec<(&str, Shown)> = homes
        .iter()
        .map(|h| (h.computer, h.home.shown(query, machine, h.computer, view)))
        .collect();

    let listed: HashSet<&String> = each.iter().flat_map(|(_, s)| &s.needs).collect();
    let needs = overview(homes)
        .needs
        .into_iter()
        .map(|a| format!("t:{}/{}", a.workspace, a.tile))
        .filter(|k| listed.contains(k))
        .collect();

    let since = |e: &Entry| match e {
        Entry::Tile { tile, .. } => tile.since,
        _ => None,
    };
    let mut working: Vec<Entry> = each.iter().flat_map(|(_, s)| s.working.clone()).collect();
    working.sort_by(|a, b| since(a).cmp(&since(b)).then_with(|| a.key().cmp(b.key())));

    let pinned = each.iter().flat_map(|(_, s)| s.pinned.clone()).collect();

    let mut machines: Vec<String> = vec![];
    for (computer, s) in &each {
        let on = if s.machines.is_empty() {
            vec![computer.to_string()]
        } else {
            s.machines.clone()
        };
        for m in on {
            if !machines.contains(&m) {
                machines.push(m);
            }
        }
    }

    let grouped = each
        .iter()
        .any(|(_, s)| s.tree.iter().any(|e| matches!(e, Entry::Section { .. })));
    let tree = if grouped {
        sections_as_one(each.iter().map(|(_, s)| s.tree.as_slice()))
    } else {
        let trees: Vec<(&str, &Vec<Entry>)> = each
            .iter()
            .filter(|(_, s)| !s.tree.is_empty())
            .map(|(c, s)| (*c, &s.tree))
            .collect();
        let headed = trees.len() > 1;
        let mut tree = vec![];
        for (computer, entries) in trees {
            if headed && !matches!(entries.first(), Some(Entry::Machine { .. })) {
                tree.push(Entry::Machine {
                    key: format!("m:{computer}"),
                    name: computer.to_string(),
                });
            }
            tree.extend(entries.iter().cloned());
        }
        tree
    };

    let mut marks = BTreeMap::new();
    for (_, s) in each {
        marks.extend(s.marks);
    }

    Shown {
        needs,
        working,
        pinned,
        machines: if machines.len() > 1 { machines } else { vec![] },
        tree,
        marks,
    }
}

/// The sections of each tree as one: a section every tree has is listed once, where it first
/// comes, with what each tree lists under it, how many in all, and what wants a look most.
fn sections_as_one<'a>(trees: impl Iterator<Item = &'a [Entry]>) -> Vec<Entry> {
    let mut order: Vec<String> = vec![];
    let mut heads: HashMap<String, Entry> = HashMap::new();
    let mut under: HashMap<String, Vec<Entry>> = HashMap::new();
    for tree in trees {
        let mut at: Option<String> = None;
        for e in tree {
            if let Entry::Section { key, .. } = e {
                at = Some(key.clone());
                match heads.get_mut(key) {
                    Some(head) => *head = merged(head, e),
                    None => {
                        order.push(key.clone());
                        heads.insert(key.clone(), e.clone());
                    }
                }
            } else if let Some(key) = &at {
                under.entry(key.clone()).or_default().push(e.clone());
            }
        }
    }
    order
        .into_iter()
        .flat_map(|key| {
            let head = heads.remove(&key);
            let rows = under.remove(&key).unwrap_or_default();
            head.into_iter().chain(rows)
        })
        .collect()
}

/// Two headings of one section as one.
fn merged(a: &Entry, b: &Entry) -> Entry {
    match (a, b) {
        (
            Entry::Section {
                key,
                label,
                count,
                state,
                folded,
            },
            Entry::Section {
                count: more,
                state: other,
                ..
            },
        ) => Entry::Section {
            key: key.clone(),
            label: label.clone(),
            count: count + more,
            state: [state, other]
                .into_iter()
                .flatten()
                .max_by_key(|s| wants_look(Some(s.as_str())))
                .cloned(),
            folded: *folded,
        },
        _ => a.clone(),
    }
}
