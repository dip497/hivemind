//! Home (spec/home.md): the phone follows the `home` stream of the computer it paired with, holds
//! the rows it is sent, and shows them as the desktop's Layers panel lists them: what waits on the
//! person first, then what is at work, then each machine's projects, frames and tiles. The computer
//! owns order, pins and each tile's last line; the phone groups and draws. Held to
//! `conformance/home.json`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ops::Not;

use anyhow::Result;
use hive_net::frames::{read_frame, write_frame};
use iroh::endpoint::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agents::{only_true, or_none, Agent, Program, Waiting, KINDS, STATES};
use crate::layers::{self, is_unread, LayerTile, Prefs};
use crate::mark::{mark_of, Icon, Mark};

/// A workspace the computer holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceRow {
    pub workspace: String,
    pub name: String,
}

/// The machine a frame's folder is on, when it is not the computer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Machine {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
}

/// The folder a frame runs in: its name, and whether it is a worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Folder {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

/// A frame of a workspace's board.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameRow {
    pub workspace: String,
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub order: u64,
    #[serde(
        default,
        deserialize_with = "or_none",
        skip_serializing_if = "Option::is_none"
    )]
    pub machine: Option<Machine>,
    #[serde(
        default,
        deserialize_with = "or_none",
        skip_serializing_if = "Option::is_none"
    )]
    pub parent_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "or_none",
        skip_serializing_if = "Option::is_none"
    )]
    pub branch: Option<String>,
    #[serde(
        default,
        deserialize_with = "or_none",
        skip_serializing_if = "Option::is_none"
    )]
    pub folder: Option<Folder>,
    /// The project it is in, when not the workspace's own.
    #[serde(
        default,
        deserialize_with = "or_none",
        skip_serializing_if = "Option::is_none"
    )]
    pub project: Option<String>,
}

/// A tile of a workspace's board, and for an agent what the agent list says of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileRow {
    pub workspace: String,
    pub id: String,
    #[serde(default, deserialize_with = "or_none")]
    pub frame_id: Option<String>,
    pub kind: String,
    pub name: String,
    #[serde(
        default,
        deserialize_with = "or_none",
        skip_serializing_if = "Option::is_none"
    )]
    pub agent: Option<String>,
    /// It runs a terminal, which can be shown and typed into.
    #[serde(
        default,
        deserialize_with = "only_true",
        skip_serializing_if = "Not::not"
    )]
    pub terminal: bool,
    #[serde(default)]
    pub order: u64,
    #[serde(
        default,
        deserialize_with = "only_true",
        skip_serializing_if = "Not::not"
    )]
    pub pinned: bool,
    #[serde(
        default,
        deserialize_with = "or_none",
        skip_serializing_if = "Option::is_none"
    )]
    pub parent: Option<String>,
    #[serde(
        default,
        deserialize_with = "or_none",
        skip_serializing_if = "Option::is_none"
    )]
    pub state: Option<String>,
    #[serde(
        default,
        deserialize_with = "or_none",
        skip_serializing_if = "Option::is_none"
    )]
    pub since: Option<u64>,
    #[serde(
        default,
        deserialize_with = "or_none",
        skip_serializing_if = "Option::is_none"
    )]
    pub waiting: Option<Waiting>,
    #[serde(
        default,
        deserialize_with = "or_none",
        skip_serializing_if = "Option::is_none"
    )]
    pub program: Option<Program>,
    #[serde(
        default,
        deserialize_with = "or_none",
        skip_serializing_if = "Option::is_none"
    )]
    pub machine: Option<String>,
    #[serde(
        default,
        deserialize_with = "only_true",
        skip_serializing_if = "Not::not"
    )]
    pub interrupt: bool,
    #[serde(
        default,
        deserialize_with = "only_true",
        skip_serializing_if = "Not::not"
    )]
    pub conversation: bool,
}

impl TileRow {
    /// An agent: it runs one, or the agent list says what it is doing.
    fn is_agent(&self) -> bool {
        self.agent.is_some() || self.state.is_some()
    }

    /// Read as the agent list is read: a state it does not know is no state, a wait it does not know
    /// no wait, and what only a permission or a question says said only of one.
    fn tidied(mut self) -> Self {
        if !self.state.as_deref().is_some_and(|s| STATES.contains(&s)) {
            self.state = None;
            self.since = None;
            self.waiting = None;
        }
        if self.since.is_none() {
            self.state = None;
            self.waiting = None;
        }
        if self.state.as_deref() != Some("waiting")
            || !self
                .waiting
                .as_ref()
                .is_some_and(|w| KINDS.contains(&w.kind.as_str()))
        {
            self.waiting = None;
        }
        if let Some(w) = self.waiting.as_mut() {
            w.decide &= w.kind == "permission";
            w.choose &= w.kind == "question";
        }
        self
    }
}

/// An agent a tile runs, by its id: what it is called, and its icon.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRow {
    pub id: String,
    pub label: String,
    pub icon: Icon,
}

/// One of Home's rows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "of", rename_all = "lowercase")]
pub enum Row {
    Workspace(WorkspaceRow),
    Frame(FrameRow),
    Tile(TileRow),
    Agent(AgentRow),
}

/// How far the phone has followed each sequence.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct At {
    pub layout: u64,
    pub lines: u64,
}

/// What the phone holds of Home: each row and each tile's last line by its key, and how far it has
/// followed. Kept as it is, it is followed on from where it was.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Home {
    pub at: Option<At>,
    pub rows: BTreeMap<String, Row>,
    pub lines: BTreeMap<String, String>,
}

/// A row read as the phone holds it; none for one it cannot read.
fn row_of(value: &Value) -> Option<Row> {
    match serde_json::from_value::<Row>(value.clone()).ok()? {
        Row::Tile(t) => Some(Row::Tile(t.tidied())),
        row => Some(row),
    }
}

/// The rows of a snapshot, `{seq, rows: [[key, row]]}`, read: its position and what each key holds.
fn snapshot_of<T>(
    value: &Value,
    read: impl Fn(&Value) -> Option<T>,
) -> Option<(u64, Vec<(String, T)>)> {
    let seq = value.get("seq")?.as_u64()?;
    let rows = value
        .get("rows")?
        .as_array()?
        .iter()
        .filter_map(|pair| {
            let key = pair.get(0)?.as_str()?;
            Some((key.to_string(), read(pair.get(1)?)?))
        })
        .collect();
    Some((seq, rows))
}

/// Apply the changes `{seq, changes}` after `at` to `held`: a change to a row it cannot read takes
/// the row away, as one that went. The new position, or none when it says none.
fn changes_into<T>(
    value: &Value,
    at: u64,
    held: &mut BTreeMap<String, T>,
    read: impl Fn(&Value) -> Option<T>,
) -> Option<u64> {
    let seq = value.get("seq")?.as_u64()?;
    for change in value.get("changes")?.as_array()? {
        let (Some(n), Some(key)) = (
            change.get("seq").and_then(Value::as_u64),
            change.get("key").and_then(Value::as_str),
        ) else {
            continue;
        };
        if n <= at {
            continue;
        }
        match change.get("row").and_then(&read) {
            Some(row) if change.get("gone").is_none() => {
                held.insert(key.to_string(), row);
            }
            _ => {
                held.remove(key);
            }
        }
    }
    Some(seq.max(at))
}

impl Home {
    /// Take in what the computer sent on the `home` stream: both sequences whole, or the changes
    /// after what is held. Whether it changed what is held. Changes before any whole are no use:
    /// ignored.
    pub fn apply(&mut self, message: &Value) -> bool {
        let before = (self.at, self.rows.len(), self.lines.len());
        match message.get("t").and_then(Value::as_str) {
            Some("home") => {
                let line = |v: &Value| v.as_str().map(str::to_string);
                let (Some((layout, rows)), Some((lines, said))) = (
                    message.get("layout").and_then(|v| snapshot_of(v, row_of)),
                    message.get("lines").and_then(|v| snapshot_of(v, line)),
                ) else {
                    return false;
                };
                self.rows = rows.into_iter().collect();
                self.lines = said.into_iter().collect();
                self.at = Some(At { layout, lines });
                true
            }
            Some("changes") => {
                let Some(mut at) = self.at else { return false };
                let rows = self.rows.clone();
                let lines = self.lines.clone();
                if let Some(v) = message.get("layout") {
                    at.layout =
                        changes_into(v, at.layout, &mut self.rows, row_of).unwrap_or(at.layout);
                }
                if let Some(v) = message.get("lines") {
                    let line = |v: &Value| v.as_str().map(str::to_string);
                    at.lines = changes_into(v, at.lines, &mut self.lines, line).unwrap_or(at.lines);
                }
                self.at = Some(at);
                rows != self.rows || lines != self.lines || before.0 != self.at
            }
            _ => false,
        }
    }

    fn tiles(&self) -> impl Iterator<Item = (&String, &TileRow)> {
        self.rows.iter().filter_map(|(k, r)| match r {
            Row::Tile(t) => Some((k, t)),
            _ => None,
        })
    }

    fn frame(&self, workspace: &str, id: &str) -> Option<&FrameRow> {
        match self.rows.get(&format!("f:{workspace}/{id}")) {
            Some(Row::Frame(f)) => Some(f),
            _ => None,
        }
    }

    fn workspace_name(&self, workspace: &str) -> Option<&str> {
        match self.rows.get(&format!("w:{workspace}")) {
            Some(Row::Workspace(w)) => Some(&w.name),
            _ => None,
        }
    }

    /// The machine a tile runs on: its frame's, else the computer, `computer`.
    fn machine_of<'a>(&'a self, t: &TileRow, computer: &'a str) -> &'a str {
        t.frame_id
            .as_deref()
            .and_then(|f| self.frame(&t.workspace, f))
            .and_then(|f| f.machine.as_ref())
            .map_or(computer, |m| m.name.as_str())
    }

    /// The agents among the tiles, as the agent list gives them: what the agent screen shows, and
    /// what waits on the person, the longest first. `device` is the computer's id, `computer` its
    /// name.
    pub fn overview(&self, device: &str, computer: &str) -> crate::agents::Overview {
        let agents = self
            .ordered_tiles()
            .into_iter()
            .filter_map(|(_, t)| {
                Some(Agent {
                    workspace: t.workspace.clone(),
                    name: self.workspace_name(&t.workspace)?.to_string(),
                    tile: t.id.clone(),
                    agent: t.name.clone(),
                    program: t.program.clone(),
                    state: t.state.clone()?,
                    since: t.since?,
                    machine: t
                        .machine
                        .clone()
                        .unwrap_or_else(|| self.machine_of(t, computer).to_string()),
                    waiting: t.waiting.clone(),
                    interrupt: t.interrupt,
                    conversation: t.conversation,
                    device: device.to_string(),
                })
            })
            .collect::<Vec<_>>();
        let working = agents.iter().filter(|a| a.state == "working").count() as u64;
        crate::agents::as_one(vec![crate::agents::Listed { agents, working }])
    }

    /// Every tile, its workspace's (by name) after another, each workspace's in the desktop's order.
    fn ordered_tiles(&self) -> Vec<(&String, &TileRow)> {
        let mut tiles: Vec<_> = self.tiles().collect();
        tiles.sort_by(|(ka, a), (kb, b)| {
            let name = |t: &TileRow| {
                self.workspace_name(&t.workspace)
                    .unwrap_or("")
                    .to_lowercase()
            };
            name(a)
                .cmp(&name(b))
                .then_with(|| a.workspace.cmp(&b.workspace))
                .then_with(|| a.order.cmp(&b.order))
                .then_with(|| ka.cmp(kb))
        });
        tiles
    }

    /// Home as the phone shows it: only the tiles whose name, agent or what runs it holds `query`
    /// (any case), and only those on the machine `machine` when one is chosen. `computer` is what
    /// the computer is called. What else shows is as `view` chooses: the View menu's choices as
    /// the desktop's Layers panel reads them (`layers`), and a project, frame or section keyed in
    /// `view.folded` listing nothing under it, but while a search finds tiles every one it finds
    /// is shown.
    pub fn shown(
        &self,
        query: &str,
        machine: Option<&str>,
        computer: &str,
        view: &HomeView,
    ) -> Shown {
        let folded = view.folded.as_slice();
        let q = query.trim().to_lowercase();
        let found = |t: &TileRow| {
            q.is_empty()
                || [
                    Some(t.name.as_str()),
                    t.agent.as_deref(),
                    t.program.as_ref().map(|p| p.label.as_str()),
                ]
                .into_iter()
                .flatten()
                .any(|s| s.to_lowercase().contains(&q))
        };
        // The machines something is on: the computer first, then the others by name.
        let mut machines: Vec<&str> = vec![computer];
        let mut others: Vec<&str> = self
            .rows
            .values()
            .filter_map(|r| match r {
                Row::Frame(f) => f.machine.as_ref().map(|m| m.name.as_str()),
                _ => None,
            })
            .filter(|m| *m != computer)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        others.sort_by_key(|m| m.to_lowercase());
        machines.extend(others);
        let on = |m: &str| machine.is_none_or(|chosen| chosen == m);
        let listed: Vec<(&String, &TileRow)> = self
            .ordered_tiles()
            .into_iter()
            .filter(|(_, t)| found(t) && on(self.machine_of(t, computer)))
            .collect();
        let entry = |key: &String, t: &TileRow, depth: u32| Entry::Tile {
            key: key.clone(),
            depth,
            tile: t.clone(),
            line: self.lines.get(key).cloned(),
            unread: false,
        };

        let overview = self.overview("", computer);
        let keep: HashSet<(&str, &str)> = listed
            .iter()
            .map(|(_, t)| (t.workspace.as_str(), t.id.as_str()))
            .collect();
        let needs = overview
            .needs
            .into_iter()
            .filter(|a| keep.contains(&(a.workspace.as_str(), a.tile.as_str())))
            .map(|a| format!("t:{}/{}", a.workspace, a.tile))
            .collect();
        let mut working: Vec<_> = listed
            .iter()
            .filter(|(_, t)| t.state.as_deref() == Some("working"))
            .collect();
        working.sort_by(|(ka, a), (kb, b)| a.since.cmp(&b.since).then_with(|| ka.cmp(kb)));
        let working = working.into_iter().map(|(k, t)| entry(k, t, 0)).collect();
        let pinned = listed
            .iter()
            .filter(|(_, t)| t.pinned)
            .map(|(k, t)| entry(k, t, 0))
            .collect();

        // The tree: each machine's projects, each project's frames, each frame's tiles.
        let mut workspaces: Vec<&WorkspaceRow> = self
            .rows
            .values()
            .filter_map(|r| match r {
                Row::Workspace(w) => Some(w),
                _ => None,
            })
            .collect();
        workspaces.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then_with(|| a.workspace.cmp(&b.workspace))
        });
        let mut frames: Vec<&FrameRow> = self
            .rows
            .values()
            .filter_map(|r| match r {
                Row::Frame(f) => Some(f),
                _ => None,
            })
            .collect();
        frames.sort_by_key(|f| f.order);
        let unpinned: Vec<(&String, &TileRow)> =
            listed.iter().filter(|(_, t)| !t.pinned).copied().collect();
        // The View menu's choices, read as the desktop reads them.
        let labels: HashMap<&str, &str> = self
            .rows
            .values()
            .filter_map(|r| match r {
                Row::Agent(a) => Some((a.id.as_str(), a.label.as_str())),
                _ => None,
            })
            .collect();
        let label = |t: &TileRow| -> String {
            t.agent
                .as_deref()
                .and_then(|a| labels.get(a).map(|l| l.to_string()))
                .or_else(|| t.program.as_ref().map(|p| p.label.clone()))
                .unwrap_or_else(|| {
                    let mut c = t.kind.chars();
                    c.next()
                        .map_or(String::new(), |f| f.to_uppercase().chain(c).collect())
                })
        };
        let layer_tiles: Vec<LayerTile> = unpinned
            .iter()
            .map(|(k, t)| LayerTile {
                id: (*k).clone(),
                name: t.name.clone(),
                frame_id: t.frame_id.clone(),
                agent: t.agent.clone(),
                status: status_of(t).to_string(),
                needs_you: t.state.as_deref() == Some("waiting"),
                activity: t.since,
                machine: self.machine_of(t, computer).to_string(),
                parent: t.parent.as_ref().map(|p| format!("t:{}/{p}", t.workspace)),
                seen: view.seen.get(*k).copied(),
            })
            .collect();
        let by_key: HashMap<&str, &TileRow> =
            unpinned.iter().map(|(k, t)| (k.as_str(), *t)).collect();
        let layer_label = |lt: &LayerTile| {
            by_key
                .get(lt.id.as_str())
                .map_or(String::new(), |t| label(t))
        };
        let chosen = layers::view(
            &layer_tiles,
            &[],
            &view.prefs,
            view.now,
            view.offset,
            &layer_label,
            "",
        );
        // Where each tile the choices let through comes, in their order.
        let mut rank: HashMap<&str, usize> = HashMap::new();
        for i in chosen
            .by_frame
            .iter()
            .flat_map(|(_, l)| l)
            .chain(chosen.buckets.iter().flat_map(|b| &b.tiles))
            .chain(chosen.kids.iter().flat_map(|(_, l)| l))
        {
            let n = rank.len();
            rank.entry(layer_tiles[*i].id.as_str()).or_insert(n);
        }
        let unpinned: Vec<(&String, &TileRow)> = unpinned
            .into_iter()
            .filter(|(k, _)| rank.contains_key(k.as_str()))
            .collect();
        let sorted = view.prefs.sort_by != "canvas";
        let filtering = !q.is_empty() || machine.is_some() || chosen.filtering;
        let in_list = |list: &[(&String, &TileRow)]| -> Vec<(String, TileRow, u32)> {
            // Agents first, each kind in the desktop's order, and a tile under the one that started
            // it when that is in the list too.
            let mut top: Vec<(&String, &TileRow)> = list.to_vec();
            if sorted {
                top.sort_by_key(|(k, _)| rank.get(k.as_str()).copied());
            } else {
                top.sort_by_key(|(_, t)| (!t.is_agent(), t.order));
            }
            let ids: HashMap<&str, &TileRow> =
                top.iter().map(|(_, t)| (t.id.as_str(), *t)).collect();
            let under = |t: &TileRow| -> Option<String> {
                let parent = t.parent.as_deref().filter(|p| ids.contains_key(p))?;
                let mut seen = HashSet::from([t.id.as_str()]);
                let mut p = Some(parent);
                while let Some(id) = p {
                    if !seen.insert(id) {
                        return None;
                    }
                    p = ids
                        .get(id)
                        .and_then(|t| t.parent.as_deref())
                        .filter(|p| ids.contains_key(p));
                }
                Some(parent.to_string())
            };
            let mut kids: HashMap<String, Vec<(&String, &TileRow)>> = HashMap::new();
            let mut roots = vec![];
            for (k, t) in &top {
                match under(t) {
                    Some(p) => kids.entry(p).or_default().push((k, t)),
                    None => roots.push((*k, *t)),
                }
            }
            let mut out = vec![];
            fn walk<'a>(
                at: (&'a String, &'a TileRow),
                depth: u32,
                kids: &HashMap<String, Vec<(&'a String, &'a TileRow)>>,
                out: &mut Vec<(String, TileRow, u32)>,
            ) {
                out.push((at.0.clone(), at.1.clone(), depth));
                for k in kids.get(&at.1.id).into_iter().flatten() {
                    walk(*k, depth + 1, kids, out);
                }
            }
            for r in roots {
                walk(r, 0, &kids, &mut out);
            }
            out
        };
        let mut groups = vec![];
        for m in machines.iter().filter(|m| on(m)) {
            let mut under_machine = vec![];
            for w in &workspaces {
                let here =
                    |f: &FrameRow| f.machine.as_ref().map_or(computer, |x| x.name.as_str()) == *m;
                let own: Vec<&FrameRow> = frames
                    .iter()
                    .copied()
                    .filter(|f| f.workspace == w.workspace && here(f))
                    .collect();
                // Projects: the workspace's own first, then each other in the order its first frame
                // comes.
                let mut projects: Vec<Option<&str>> = vec![None];
                for f in own.iter().filter(|f| f.parent_id.is_none()) {
                    if let Some(p) = f.project.as_deref() {
                        if !projects.contains(&Some(p)) {
                            projects.push(Some(p));
                        }
                    }
                }
                for project in projects {
                    let mut entries = vec![];
                    let tops = own
                        .iter()
                        .filter(|f| f.parent_id.is_none() && f.project.as_deref() == project);
                    let first = tops.clone().next().map(|f| f.id.clone());
                    let name = project.unwrap_or(&w.name).to_string();
                    // A project's only frame, called as the project is and with no frame under
                    // it, is the project: no row of its own, its tiles the project's.
                    let bare = match tops.clone().collect::<Vec<_>>().as_slice() {
                        [only] => {
                            !own.iter().any(|k| k.parent_id.as_deref() == Some(&only.id))
                                && only.title.trim().to_lowercase() == name.trim().to_lowercase()
                        }
                        _ => false,
                    };
                    fn frame_entries<'a>(
                        f: &'a FrameRow,
                        depth: u32,
                        bare: bool,
                        own: &[&'a FrameRow],
                        tiles_of: &dyn Fn(&str) -> Vec<(String, TileRow, u32)>,
                        filtering: bool,
                        out: &mut Vec<Entry>,
                    ) -> bool {
                        let mut mine = vec![];
                        let mut any = false;
                        for (key, tile, d) in tiles_of(&f.id) {
                            any = true;
                            mine.push(Entry::Tile {
                                line: None,
                                unread: false,
                                key,
                                depth: depth + u32::from(!bare) + d,
                                tile,
                            });
                        }
                        for k in own.iter().filter(|k| k.parent_id.as_deref() == Some(&f.id)) {
                            any |= frame_entries(
                                k,
                                depth + 1,
                                false,
                                own,
                                tiles_of,
                                filtering,
                                &mut mine,
                            );
                        }
                        if filtering && !any {
                            return false;
                        }
                        if !bare {
                            out.push(Entry::Frame {
                                key: format!("f:{}/{}", f.workspace, f.id),
                                depth,
                                frame: f.clone(),
                                count: 0,
                                state: None,
                                folded: false,
                            });
                        }
                        out.extend(mine);
                        true
                    }
                    let tiles_of = |frame: &str| {
                        let list: Vec<_> = unpinned
                            .iter()
                            .filter(|(_, t)| {
                                t.workspace == w.workspace && t.frame_id.as_deref() == Some(frame)
                            })
                            .copied()
                            .collect();
                        in_list(&list)
                    };
                    let mut shown = false;
                    for f in tops {
                        shown |=
                            frame_entries(f, 0, bare, &own, &tiles_of, filtering, &mut entries);
                    }
                    // Tiles in no frame, or in one that is gone: the workspace's own project, on the
                    // computer.
                    if project.is_none() && *m == computer {
                        let loose: Vec<_> = unpinned
                            .iter()
                            .filter(|(_, t)| {
                                t.workspace == w.workspace
                                    && t.frame_id
                                        .as_deref()
                                        .is_none_or(|f| self.frame(&w.workspace, f).is_none())
                            })
                            .copied()
                            .collect();
                        for (key, tile, depth) in in_list(&loose) {
                            entries.push(Entry::Tile {
                                line: None,
                                unread: false,
                                key,
                                depth,
                                tile,
                            });
                        }
                    }
                    if entries.is_empty() && !shown {
                        continue;
                    }
                    under_machine.push(Entry::Project {
                        key: format!("p:{m}/{}/{}", w.workspace, project.unwrap_or("")),
                        name,
                        workspace: w.workspace.clone(),
                        frame: first,
                        count: 0,
                        state: None,
                        folded: false,
                    });
                    under_machine.extend(entries);
                }
            }
            if !under_machine.is_empty() {
                groups.push((*m, under_machine));
            }
        }
        // One machine needs no heading to say which.
        let headed = groups.len() > 1;
        let mut tree = vec![];
        for (m, entries) in groups {
            if headed {
                tree.push(Entry::Machine {
                    key: format!("m:{m}"),
                    name: m.to_string(),
                });
            }
            tree.extend(entries);
        }
        // Grouped by status, date or agent, or not at all: a heading each, its tiles under it,
        // each over the tiles it started.
        if !chosen.tree {
            tree.clear();
            let kids: HashMap<&str, &Vec<usize>> =
                chosen.kids.iter().map(|(p, l)| (p.as_str(), l)).collect();
            fn walk(
                i: usize,
                depth: u32,
                tiles: &[LayerTile],
                rows: &HashMap<&str, &TileRow>,
                kids: &HashMap<&str, &Vec<usize>>,
                out: &mut Vec<Entry>,
            ) {
                let key = &tiles[i].id;
                let Some(tile) = rows.get(key.as_str()) else {
                    return;
                };
                out.push(Entry::Tile {
                    key: key.clone(),
                    depth,
                    tile: (*tile).clone(),
                    line: None,
                    unread: false,
                });
                for &k in kids.get(key.as_str()).map_or(&[][..], |l| l.as_slice()) {
                    walk(k, depth + 1, tiles, rows, kids, out);
                }
            }
            for b in &chosen.buckets {
                tree.push(Entry::Section {
                    key: format!("s:{}", b.key),
                    label: b.label.clone(),
                    count: 0,
                    state: None,
                    folded: false,
                });
                for &i in &b.tiles {
                    walk(i, 0, &layer_tiles, &by_key, &kids, &mut tree);
                }
            }
        }
        for e in &mut tree {
            if let Entry::Tile { key, line, .. } = e {
                *line = self.lines.get(key).cloned();
            }
        }
        let mut tree = folded_tree(tree, if q.is_empty() { folded } else { &[] });
        let mut working: Vec<Entry> = working;
        let mut pinned: Vec<Entry> = pinned;
        let mut marks: BTreeMap<String, Mark> = BTreeMap::new();
        for e in tree
            .iter_mut()
            .chain(working.iter_mut())
            .chain(pinned.iter_mut())
        {
            if let Entry::Tile {
                key, tile, unread, ..
            } = e
            {
                if let Some(a) = tile.agent.as_deref() {
                    if !marks.contains_key(a) {
                        if let Some(Row::Agent(row)) = self.rows.get(&format!("a:{a}")) {
                            if let Some(m) = mark_of(&row.icon) {
                                marks.insert(a.to_string(), m);
                            }
                        }
                    }
                }
                *unread = is_unread(
                    status_of(tile),
                    tile.since,
                    view.seen.get(key.as_str()).copied(),
                );
            }
        }
        Shown {
            needs,
            working,
            pinned,
            machines: if machines.len() > 1 {
                machines.iter().map(|m| m.to_string()).collect()
            } else {
                vec![]
            },
            tree,
            marks,
        }
    }
}

/// What the person chose to see on Home, kept by the app and given with each call: the View
/// menu's choices, the projects, frames and sections folded (by key), when they last opened each
/// tile (ms, by key), the time now and how many minutes the clock is ahead of UTC.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct HomeView {
    pub prefs: Prefs,
    pub folded: Vec<String>,
    pub seen: HashMap<String, u64>,
    pub now: u64,
    pub offset: i64,
}

/// A tile's status as `tile-status.ts` reads it: exited; waiting, by what on; working; else idle.
pub fn status_of(t: &TileRow) -> &'static str {
    match t.state.as_deref() {
        Some("exited") => "exited",
        Some("waiting") => match t.waiting.as_ref().map(|w| w.kind.as_str()) {
            Some("permission") => "permission",
            Some("question") => "question",
            Some("plan") => "plan_review",
            Some("approval") => "awaiting_approval",
            _ => "blocked",
        },
        Some("working") => "working",
        _ => "idle",
    }
}

/// How much a tile's state wants a look, from 3 (it waits) down; 0 for none worth saying.
fn wants_look(state: Option<&str>) -> u8 {
    match state {
        Some("waiting") => 3,
        Some("working") => 2,
        Some("exited") => 1,
        _ => 0,
    }
}

/// Where what is under the entry at `at` of `tree` ends: a project's or a section's at the next
/// machine, project or section, a frame's at the next row no deeper than it.
fn under_end(tree: &[Entry], at: usize) -> usize {
    let depth = match &tree[at] {
        Entry::Frame { depth, .. } => Some(*depth),
        _ => None,
    };
    tree[at + 1..]
        .iter()
        .position(|e| match e {
            Entry::Machine { .. } | Entry::Project { .. } | Entry::Section { .. } => true,
            Entry::Frame { depth: d, .. } | Entry::Tile { depth: d, .. } => {
                depth.is_some_and(|depth| *d <= depth)
            }
        })
        .map_or(tree.len(), |n| at + 1 + n)
}

/// `tree` with each project and frame saying what is under it, and what is under one keyed in
/// `folded` left out.
fn folded_tree(mut tree: Vec<Entry>, folded: &[String]) -> Vec<Entry> {
    for at in 0..tree.len() {
        if matches!(tree[at], Entry::Machine { .. } | Entry::Tile { .. }) {
            continue;
        }
        let end = under_end(&tree, at);
        let (top, under) = (
            match &tree[at] {
                Entry::Frame { depth, .. } => depth + 1,
                _ => 0,
            },
            &tree[at + 1..end],
        );
        let rows = under
            .iter()
            .filter(|e| matches!(e, Entry::Frame { depth, .. } | Entry::Tile { depth, .. } if *depth == top))
            .count() as u32;
        let most = under
            .iter()
            .filter_map(|e| match e {
                Entry::Tile { tile, .. } => tile.state.as_deref(),
                _ => None,
            })
            .max_by_key(|s| wants_look(Some(s)))
            .filter(|s| wants_look(Some(s)) > 0)
            .map(str::to_string);
        if let Entry::Project {
            key,
            count,
            state,
            folded: f,
            ..
        }
        | Entry::Frame {
            key,
            count,
            state,
            folded: f,
            ..
        }
        | Entry::Section {
            key,
            count,
            state,
            folded: f,
            ..
        } = &mut tree[at]
        {
            *count = rows;
            *state = most;
            *f = folded.contains(key);
        }
    }
    let mut next = 0;
    let keep: Vec<bool> = (0..tree.len())
        .map(|at| {
            if at < next {
                return false;
            }
            let fold = matches!(
                &tree[at],
                Entry::Project { folded: true, .. }
                    | Entry::Frame { folded: true, .. }
                    | Entry::Section { folded: true, .. }
            );
            next = if fold { under_end(&tree, at) } else { at + 1 };
            true
        })
        .collect();
    tree.into_iter()
        .zip(keep)
        .filter_map(|(e, k)| k.then_some(e))
        .collect()
}

/// One line of a list Home shows. A project and a frame say what is under them: how many rows
/// one level down (`count`), the state among its tiles that most wants a look (`state`: waiting,
/// then working, then failed or limited), and whether the person folded it (`folded`), which
/// leaves out what is under it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "of", rename_all = "lowercase")]
pub enum Entry {
    Machine {
        key: String,
        name: String,
    },
    /// `frame`: its first frame, where an agent started from its heading runs.
    Project {
        key: String,
        name: String,
        workspace: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        frame: Option<String>,
        count: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        state: Option<String>,
        folded: bool,
    },
    Frame {
        key: String,
        depth: u32,
        frame: FrameRow,
        count: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        state: Option<String>,
        folded: bool,
    },
    /// A heading of a grouping that is not the tree (by status, date, agent; none has no label).
    Section {
        key: String,
        label: String,
        count: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        state: Option<String>,
        folded: bool,
    },
    /// `unread`: done since the person last opened it.
    Tile {
        key: String,
        depth: u32,
        tile: TileRow,
        #[serde(skip_serializing_if = "Option::is_none")]
        line: Option<String>,
        unread: bool,
    },
}

impl Entry {
    pub fn key(&self) -> &str {
        match self {
            Entry::Machine { key, .. }
            | Entry::Project { key, .. }
            | Entry::Frame { key, .. }
            | Entry::Section { key, .. }
            | Entry::Tile { key, .. } => key,
        }
    }
}

/// Home as the phone shows it.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Shown {
    /// What waits on the person, the longest first: tile keys, each an agent of the overview.
    pub needs: Vec<String>,
    /// At work, the longest first.
    pub working: Vec<Entry>,
    /// Pinned, in the desktop's order: listed here and nowhere else in the tree.
    pub pinned: Vec<Entry>,
    /// The machines to choose from, when there is more than one.
    pub machines: Vec<String>,
    pub tree: Vec<Entry>,
    /// The mark of each agent a tile listed runs, by agent: drawn once, however many run it.
    pub marks: BTreeMap<String, Mark>,
}

/// Follow Home on the computer at the other end of `connection`, from the positions `at` (none:
/// from nothing): each message it sends is handed to `told`, as its text, for a `Home` to apply,
/// until the computer closes the stream.
pub async fn follow(
    connection: &Connection,
    at: Option<At>,
    mut told: impl FnMut(&str),
) -> Result<()> {
    let (mut send, mut recv) = hive_net::ws::open(connection, "home").await?;
    let asked = match at {
        Some(at) => json!({ "t": "follow", "layout": at.layout, "lines": at.lines }),
        None => json!({ "t": "follow" }),
    };
    write_frame(&mut send, asked.to_string().as_bytes()).await?;
    while let Some(frame) = read_frame(&mut recv).await? {
        if let Ok(text) = std::str::from_utf8(&frame) {
            told(text);
        }
    }
    Ok(())
}
