//! Home (spec/home.md) as the apps draw it: each app the phone reached, its tree as the desktop's
//! Layers panel lists it, what waits on the person and what is at work. The core holds and groups
//! (`hive_phone::home`); these are its lists as records.

use std::collections::HashMap;

use hive_phone::home::{self, Entry, HomeView, Row, TileRow};
use hive_phone::layers::Prefs;
use hive_phone::mark::Mark;

use crate::records::{AgentRef, AgentState, WaitKind};

/// What the person chose to see on Home, as the app keeps it: the View menu's choices (`status`
/// all, needs-you, unread, working, idle or exited; `activity` all, hour, today or week; `group_by`
/// group, machine, date, status, agent or none; `sort_by` canvas, activity or name), the keys of
/// what they folded, when they last opened each tile (ms, by its key), and how many minutes the
/// phone's clock is ahead of UTC.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct HomeChoices {
    pub status: String,
    pub activity: String,
    pub group_by: String,
    pub sort_by: String,
    pub folded: Vec<String>,
    pub seen: HashMap<String, u64>,
    pub offset_minutes: i32,
}

impl Default for HomeChoices {
    fn default() -> Self {
        let p = Prefs::default();
        Self {
            status: p.status,
            activity: p.activity,
            group_by: p.group_by,
            sort_by: p.sort_by,
            folded: vec![],
            seen: HashMap::new(),
            offset_minutes: 0,
        }
    }
}

impl HomeChoices {
    fn view(&self) -> HomeView {
        HomeView {
            prefs: Prefs {
                status: self.status.clone(),
                activity: self.activity.clone(),
                group_by: self.group_by.clone(),
                sort_by: self.sort_by.clone(),
                machines: vec![],
            },
            folded: self.folded.clone(),
            seen: self.seen.clone(),
            now: hive_phone::now_ms(),
            offset: i64::from(self.offset_minutes),
        }
    }
}

/// Home on one of the person's computers.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct HomeShown {
    /// The computer's id, and what it is called.
    pub device: String,
    pub computer: String,
    /// What waits on the person, the longest first: each an agent of the overview.
    pub needs: Vec<AgentRef>,
    /// At work, the longest first.
    pub working: Vec<HomeEntry>,
    /// Pinned, in the desktop's order: listed here and nowhere else in the tree.
    pub pinned: Vec<HomeEntry>,
    /// The machines to choose from, when there is more than one.
    pub machines: Vec<String>,
    pub tree: Vec<HomeEntry>,
    /// The mark of each agent a tile listed runs, by agent: one path to draw however many run it.
    pub marks: HashMap<String, AgentMark>,
}

/// One line of a list Home shows; `key` names it in every list it is in. A project and a frame
/// say how many rows are one level under them, the state among their tiles that most wants a look,
/// and whether the person folded them.
#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum HomeEntry {
    Machine {
        key: String,
        name: String,
    },
    /// `frame`: its first frame, where an agent started from its heading runs.
    Project {
        key: String,
        name: String,
        workspace: String,
        frame: Option<String>,
        count: u32,
        state: Option<AgentState>,
        folded: bool,
    },
    /// `folder`: the folder it runs in, when not its title. `worktree`: it is a branch's own
    /// folder, `branch` when it says which.
    Frame {
        key: String,
        depth: u32,
        title: String,
        color: String,
        folder: Option<String>,
        worktree: bool,
        branch: Option<String>,
        count: u32,
        state: Option<AgentState>,
        folded: bool,
    },
    /// A heading of a grouping that is not the tree; one with no label heads the one list.
    Section {
        key: String,
        label: String,
        count: u32,
        state: Option<AgentState>,
        folded: bool,
    },
    Tile {
        key: String,
        depth: u32,
        tile: HomeTile,
    },
}

/// An agent's mark, drawn in one colour in the box `x`, `y`, `width`, `height`: its paths in order.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct AgentMark {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub shapes: Vec<MarkShape>,
}

/// One path of a mark: `d` holds only absolute `M`, `L`, `C`, `Q` and `Z`. Filled when `fill`
/// (by the even-odd rule when `even_odd`), outlined `stroke` wide when above 0, round-ended when
/// `round`, at `opacity`.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct MarkShape {
    pub d: String,
    pub fill: bool,
    pub even_odd: bool,
    pub stroke: f64,
    pub round: bool,
    pub opacity: f64,
}

impl From<Mark> for AgentMark {
    fn from(m: Mark) -> Self {
        Self {
            x: m.x,
            y: m.y,
            width: m.width,
            height: m.height,
            shapes: m
                .shapes
                .into_iter()
                .map(|s| MarkShape {
                    d: s.d,
                    fill: s.fill,
                    even_odd: s.even_odd,
                    stroke: s.stroke,
                    round: s.round,
                    opacity: s.opacity,
                })
                .collect(),
        }
    }
}

/// A tile of a board, and for an agent what the agent list says of it.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct HomeTile {
    pub at: AgentRef,
    pub name: String,
    /// What it is on the board: `terminal`, `notes`, a widget's kind.
    pub kind: String,
    /// It runs an agent.
    pub agent: bool,
    /// It runs a terminal, which can be shown and typed into.
    pub terminal: bool,
    pub state: Option<AgentState>,
    /// When it entered its state.
    pub since: Option<u64>,
    /// What it waits on the person for, and its tool and what about (its command, its file), or
    /// its first question.
    pub waits: Option<WaitKind>,
    pub tool: Option<String>,
    pub about: Option<String>,
    pub question: Option<String>,
    /// What it last said, or its screen's last line with text.
    pub line: Option<String>,
    /// The program it is: "Claude Code".
    pub program: Option<String>,
    /// Its turn can be stopped from here.
    pub interrupt: bool,
    /// The agent it runs, which names its mark in `HomeShown.marks` when this computer knows it.
    pub runs: Option<String>,
    /// Done since the person last opened it here.
    pub unread: bool,
}

/// Home on `device`, called `computer`, as `held` shows it: what holds `query`, on `machine` when
/// one is chosen.
pub(crate) fn shown(
    device: &str,
    computer: &str,
    held: &home::Home,
    query: &str,
    machine: Option<&str>,
    choices: &HomeChoices,
) -> HomeShown {
    let shown = held.shown(query, machine, computer, &choices.view());
    let entries = |entries: Vec<Entry>| -> Vec<HomeEntry> {
        entries
            .into_iter()
            .map(|entry| HomeEntry::of(entry, device))
            .collect()
    };
    HomeShown {
        device: device.to_string(),
        computer: computer.to_string(),
        needs: shown
            .needs
            .iter()
            .filter_map(|key| match held.rows.get(key)? {
                Row::Tile(t) => Some(at(device, t)),
                _ => None,
            })
            .collect(),
        working: entries(shown.working),
        pinned: entries(shown.pinned),
        machines: shown.machines,
        tree: entries(shown.tree),
        marks: shown
            .marks
            .into_iter()
            .map(|(agent, mark)| (agent, AgentMark::from(mark)))
            .collect(),
    }
}

fn at(device: &str, tile: &TileRow) -> AgentRef {
    AgentRef {
        device: device.to_string(),
        workspace: tile.workspace.clone(),
        tile: tile.id.clone(),
    }
}

impl HomeEntry {
    fn of(entry: Entry, device: &str) -> Self {
        match entry {
            Entry::Machine { key, name } => Self::Machine { key, name },
            Entry::Project {
                key,
                name,
                workspace,
                frame,
                count,
                state,
                folded,
            } => Self::Project {
                key,
                name,
                workspace,
                frame,
                count,
                state: state.as_deref().and_then(AgentState::named),
                folded,
            },
            Entry::Frame {
                key,
                depth,
                frame,
                count,
                state,
                folded,
            } => Self::Frame {
                key,
                depth,
                worktree: frame.parent_id.is_some()
                    || frame.folder.as_ref().and_then(|f| f.kind.as_deref()) == Some("worktree"),
                branch: frame.branch.clone(),
                folder: frame
                    .folder
                    .map(|f| f.name)
                    .filter(|name| *name != frame.title),
                title: frame.title,
                color: frame.color,
                count,
                state: state.as_deref().and_then(AgentState::named),
                folded,
            },
            Entry::Section {
                key,
                label,
                count,
                state,
                folded,
            } => Self::Section {
                key,
                label,
                count,
                state: state.as_deref().and_then(AgentState::named),
                folded,
            },
            Entry::Tile {
                key,
                depth,
                tile,
                line,
                unread,
            } => {
                let waiting = tile.waiting.as_ref();
                let tool = waiting.and_then(|w| w.tool.as_ref());
                Self::Tile {
                    key,
                    depth,
                    tile: HomeTile {
                        at: at(device, &tile),
                        agent: tile.agent.is_some() || tile.state.is_some(),
                        terminal: tile.terminal,
                        state: tile.state.as_deref().and_then(AgentState::named),
                        since: tile.since,
                        waits: waiting.map(|w| WaitKind::named(&w.kind)),
                        tool: tool.map(|t| t.name.clone()),
                        about: tool
                            .and_then(|t| t.about.as_deref()?.lines().next().map(str::to_string)),
                        question: waiting
                            .and_then(|w| w.asks.as_ref()?.first().map(|a| a.question.clone())),
                        line,
                        program: tile.program.as_ref().map(|p| p.label.clone()),
                        interrupt: tile.interrupt,
                        runs: tile.agent.clone(),
                        unread,
                        name: tile.name,
                        kind: tile.kind,
                    },
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_tile_that_waits_is_needed_on_its_computer_and_its_row_says_its_tool_and_the_first_line_of_its_command(
    ) {
        let mut held = home::Home::default();
        let waits = json!({
            "of": "tile", "workspace": "w1", "id": "t1", "frameId": null, "kind": "terminal",
            "name": "api", "agent": "claude", "terminal": true, "state": "waiting", "since": 5,
            "waiting": { "kind": "permission", "since": 5, "tool": { "name": "Bash", "about": "rm -rf build\nmake all" } },
            "program": { "id": "claude", "label": "Claude Code" }, "interrupt": true,
        });
        let shell = json!({
            "of": "tile", "workspace": "w1", "id": "t2", "frameId": null, "kind": "terminal",
            "name": "shell", "terminal": true,
        });
        let changed = held.apply(&json!({
            "t": "home",
            "layout": { "seq": 1, "rows": [
                ["w:w1", { "of": "workspace", "workspace": "w1", "name": "api" }],
                ["t:w1/t1", waits], ["t:w1/t2", shell],
            ] },
            "lines": { "seq": 1, "rows": [["t:w1/t2", "$ make"]] },
        }));
        assert!(changed);

        let shown = shown(
            "dev1",
            "Priya's laptop",
            &held,
            "",
            None,
            &HomeChoices::default(),
        );
        let at = |tile: &str| AgentRef {
            device: "dev1".into(),
            workspace: "w1".into(),
            tile: tile.into(),
        };
        assert_eq!(shown.needs, vec![at("t1")]);
        let tiles: Vec<&HomeTile> = shown
            .tree
            .iter()
            .filter_map(|e| match e {
                HomeEntry::Tile { tile, .. } => Some(tile),
                _ => None,
            })
            .collect();
        assert_eq!(tiles.len(), 2, "{:?}", shown.tree);
        let (agent, shell) = (tiles[0], tiles[1]);
        assert_eq!(
            (agent.at.clone(), agent.agent, agent.state, agent.waits),
            (
                at("t1"),
                true,
                Some(AgentState::Waiting),
                Some(WaitKind::Permission)
            )
        );
        assert_eq!(
            (
                agent.tool.as_deref(),
                agent.about.as_deref(),
                agent.program.as_deref()
            ),
            (Some("Bash"), Some("rm -rf build"), Some("Claude Code"))
        );
        assert_eq!(
            (shell.agent, shell.state, shell.line.as_deref()),
            (false, None, Some("$ make"))
        );
    }
}
