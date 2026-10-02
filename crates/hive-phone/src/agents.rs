//! Every agent of the person's (spec/agents.md "Following", M5): the phone follows each of the
//! person's devices it reaches on that device's `agents` stream, and is sent the agents there as
//! they change. It shows each device's list as that device last sent it, what waits on the person
//! among them as one list, the one waiting longest first, and how many are at work. Held to
//! `conformance/agents.json`.

use std::ops::Not;

use anyhow::Result;
use hive_net::frames::{read_frame, write_frame};
use iroh::endpoint::Connection;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};

/// The states an agent is in (spec/status.md).
const STATES: [&str; 8] = [
    "idle",
    "working",
    "waiting",
    "done",
    "failed",
    "interrupted",
    "limited",
    "exited",
];
/// What an agent waits for: on the person, or on the agent supervising it (`approval`).
const KINDS: [&str; 5] = ["permission", "question", "plan", "other", "approval"];

/// The agent a tile runs, by its manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Program {
    pub id: String,
    pub label: String,
}

/// What an agent waits for, while it waits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Waiting {
    pub kind: String,
    /// When it began waiting (ms since the epoch): with its tile, which wait this is.
    pub since: u64,
    /// The plan it waits on review of, in markdown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    /// A permission its device can allow or deny (spec/needs.md 0.5).
    #[serde(
        default,
        deserialize_with = "only_true",
        skip_serializing_if = "Not::not"
    )]
    pub decide: bool,
}

/// An agent of the person's, as the device that runs it says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Agent {
    /// The workspace it is in: its id, and its name.
    pub workspace: String,
    pub name: String,
    pub tile: String,
    /// What it is called.
    pub agent: String,
    #[serde(
        default,
        deserialize_with = "program_or_none",
        skip_serializing_if = "Option::is_none"
    )]
    pub program: Option<Program>,
    /// Its state, and when that last changed (ms since the epoch).
    pub state: String,
    pub since: u64,
    /// What the machine it runs on is called.
    pub machine: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting: Option<Waiting>,
    /// Its turn can be interrupted from here (`agent.interrupt`).
    #[serde(
        default,
        deserialize_with = "only_true",
        skip_serializing_if = "Not::not"
    )]
    pub interrupt: bool,
    /// The device that told of it: the phone's own word, never the device's.
    #[serde(default)]
    pub device: String,
}

impl Agent {
    /// Whether it waits on the person (not on the agent supervising it).
    pub fn waits_on_the_person(&self) -> bool {
        self.waiting.as_ref().is_some_and(|w| w.kind != "approval")
    }
}

/// `true` as itself; anything else as not said.
fn only_true<'de, D: Deserializer<'de>>(said: D) -> Result<bool, D::Error> {
    Ok(Value::deserialize(said)? == Value::Bool(true))
}

/// A program, when it is an id and a label; anything else as not said.
fn program_or_none<'de, D: Deserializer<'de>>(said: D) -> Result<Option<Program>, D::Error> {
    Ok(serde_json::from_value(Value::deserialize(said)?).ok())
}

/// What one device says: its agents, and how many are at work there.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Listed {
    pub agents: Vec<Agent>,
    pub working: u64,
}

/// What the device `from` sending `answer` says: its agents, each that can be read, as it
/// listed them, and how many are at work (none when it says it as anything but a whole number of
/// none or more). None for anything that is not a list of agents.
pub fn read_answer(answer: &Value, from: &str) -> Option<Listed> {
    if answer.get("t").and_then(Value::as_str) != Some("agents") {
        return None;
    }
    let items = answer.get("agents")?.as_array()?;
    let agents = items
        .iter()
        .filter_map(|item| serde_json::from_value::<Agent>(item.clone()).ok())
        .filter(|a| STATES.contains(&a.state.as_str()))
        .filter(|a| {
            a.waiting
                .as_ref()
                .is_none_or(|w| KINDS.contains(&w.kind.as_str()))
        })
        .map(|mut a| {
            if let Some(w) = a.waiting.as_mut() {
                w.decide &= w.kind == "permission";
            }
            a.device = from.to_string();
            a
        })
        .collect();
    Some(Listed {
        agents,
        working: answer.get("working").and_then(Value::as_u64).unwrap_or(0),
    })
}

/// The person's agents, as the phone shows them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Overview {
    /// Every agent: one device's after another, each device's as it listed them.
    pub agents: Vec<Agent>,
    /// Those waiting on the person: the one waiting longest first, and of two waiting since the
    /// same moment, the one whose tile comes first.
    pub needs: Vec<Agent>,
    pub working: u64,
}

/// Several devices' lists as the phone shows them.
pub fn as_one(lists: Vec<Listed>) -> Overview {
    let working = lists.iter().fold(0u64, |n, l| n.saturating_add(l.working));
    let agents: Vec<Agent> = lists.into_iter().flat_map(|l| l.agents).collect();
    let mut needs: Vec<Agent> = agents
        .iter()
        .filter(|a| a.waits_on_the_person())
        .cloned()
        .collect();
    let since = |a: &Agent| a.waiting.as_ref().map_or(0, |w| w.since);
    needs.sort_by(|a, b| since(a).cmp(&since(b)).then_with(|| a.tile.cmp(&b.tile)));
    Overview {
        agents,
        needs,
        working,
    }
}

/// Follow every agent on the device `from` at the other end of `connection`: each list it sends
/// is handed to `listed` as it comes, until the device closes the stream.
pub async fn follow(
    connection: &Connection,
    from: &str,
    mut listed: impl FnMut(Listed),
) -> Result<()> {
    let (mut send, mut recv) = hive_net::ws::open(connection, "agents").await?;
    write_frame(&mut send, json!({ "t": "follow" }).to_string().as_bytes()).await?;
    while let Some(frame) = read_frame(&mut recv).await? {
        let Ok(answer) = serde_json::from_slice::<Value>(&frame) else {
            continue;
        };
        if let Some(list) = read_answer(&answer, from) {
            listed(list);
        }
    }
    Ok(())
}
