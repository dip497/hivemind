//! What waits on the person (spec/needs.md, M5): the phone asks each of the person's devices it
//! knows, which work it out from the agents they run, and shows the lists as one, the one waiting
//! longest first, with how many agents are at work on them; of a device that is away, what it last
//! answered and when. Held to `conformance/needs.json`.

use std::{collections::BTreeMap, fs};

use anyhow::Result;
use iroh::{endpoint::Connection, Endpoint};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    agents::{Agent, Listed, Waiting},
    devices::{self, ANSWER_WITHIN},
    identity::{write_private, Identity},
    pairing::PairedWith,
    workspace::Held,
};

/// What an agent can wait on the person for.
const KINDS: [&str; 4] = ["permission", "question", "plan", "other"];

/// An agent waiting on the person.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Need {
    /// The workspace it is in: its id, and its name.
    pub workspace: String,
    pub name: String,
    pub tile: String,
    /// What the agent is called.
    pub agent: String,
    /// What it waits for.
    pub kind: String,
    /// When it began waiting, ms since the epoch.
    pub since: u64,
    /// A plan it waits on review of.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    /// What the machine it runs on is called (0.3): as the device that answered says, else that
    /// device's name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    /// A permission the device can allow or deny (0.5): the phone may offer Allow / Deny. Said
    /// only as `true`, and only of a permission.
    #[serde(
        default,
        deserialize_with = "only_true",
        skip_serializing_if = "std::ops::Not::not"
    )]
    pub decide: bool,
}

/// `true` as itself; anything else as not said.
fn only_true<'de, D: serde::Deserializer<'de>>(said: D) -> Result<bool, D::Error> {
    Ok(Value::deserialize(said)? == Value::Bool(true))
}

/// What a device answers: what waits on the person there, and how many agents are at work there.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Answer {
    pub needs: Vec<Need>,
    pub working: u64,
}

/// What the device called `from` answering `answer` says: what waits on the person, each item
/// that says all it must, as the device ordered them, on the machine it says (else on `from`,
/// a device of 0.2), a permission it can allow or deny said so; and how many agents are at work
/// (none when it does not say, or says it as anything but a whole number of none or more).
/// Anything that is not an answer says nothing.
pub fn read_answer(answer: &Value, from: &str) -> Answer {
    if answer.get("t").and_then(Value::as_str) != Some("needs") {
        return Answer::default();
    }
    let Some(items) = answer.get("needs").and_then(Value::as_array) else {
        return Answer::default();
    };
    Answer {
        needs: items
            .iter()
            .filter_map(|item| serde_json::from_value::<Need>(item.clone()).ok())
            .filter(|need| KINDS.contains(&need.kind.as_str()))
            .map(|need| Need {
                machine: need.machine.or_else(|| Some(from.to_string())),
                decide: need.decide && need.kind == "permission",
                ..need
            })
            .collect(),
        working: answer.get("working").and_then(Value::as_u64).unwrap_or(0),
    }
}

/// Several devices' answers as one: their lists as one, the one waiting longest first, and of two
/// waiting since the same moment, the one whose tile comes first; and the agents at work on all
/// of them.
pub fn as_one(answers: Vec<Answer>) -> Answer {
    let working = answers
        .iter()
        .fold(0u64, |n, a| n.saturating_add(a.working));
    let mut needs: Vec<Need> = answers.into_iter().flat_map(|a| a.needs).collect();
    needs.sort_by(|a, b| a.since.cmp(&b.since).then_with(|| a.tile.cmp(&b.tile)));
    Answer { needs, working }
}

/// Ask `device`, from this phone's `endpoint`, what waits on the person there.
pub async fn ask(endpoint: &Endpoint, device: &PairedWith) -> Result<Answer> {
    let asked = async {
        let at = hive_net::net::addr_of(&device.device, &device.addrs, &device.relay)?;
        let connection = endpoint.connect(at, hive_net::ws::ALPN).await?;
        let answer = ask_on(&connection, &device.name).await?;
        connection.close(0u32.into(), b"done");
        Ok::<_, anyhow::Error>(answer)
    };
    tokio::time::timeout(ANSWER_WITHIN, asked)
        .await
        .map_err(|_| anyhow::anyhow!("{} did not answer", device.name))?
}

/// Ask the device called `from`, on `connection` to it, what waits on the person there.
pub async fn ask_on(connection: &Connection, from: &str) -> Result<Answer> {
    let answer = devices::ask(connection, &json!({ "t": "needs" })).await?;
    Ok(read_answer(&answer, from))
}

/// What a device last told this phone, and when (ms since the epoch).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Heard {
    /// When it last told anything: what waits on the person there, its agents, or the workspaces
    /// it holds.
    pub at: u64,
    /// What waits on the person there, and how many agents are at work: as it answered, or as
    /// its list of agents says. None until it has said: a device reached tells the workspaces it
    /// holds first, which says nothing of what waits there.
    #[serde(flatten)]
    pub answer: Option<Answer>,
    /// When it said that: none until it has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answered: Option<u64>,
    /// Every agent there, as it last listed them (spec/agents.md "Following"): none from a device
    /// that does not list them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents: Option<Vec<Agent>>,
    /// The workspaces it holds.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workspaces: Vec<Held>,
}

impl Heard {
    /// Every agent the device `device` told of: as it listed them, or, from a device that does not
    /// list them, those that waited on the person. None until it has said.
    pub fn listed(&self, device: &str) -> Option<Listed> {
        let answer = self.answer.as_ref()?;
        let agents = match &self.agents {
            Some(agents) => agents
                .iter()
                .map(|agent| Agent {
                    device: device.to_string(),
                    ..agent.clone()
                })
                .collect(),
            None => answer.needs.iter().map(|n| agent_of(n, device)).collect(),
        };
        Some(Listed {
            agents,
            working: answer.working,
        })
    }
}

/// An agent that waits on the person, as a device that does not list its agents says it.
fn agent_of(need: &Need, device: &str) -> Agent {
    Agent {
        workspace: need.workspace.clone(),
        name: need.name.clone(),
        tile: need.tile.clone(),
        agent: need.agent.clone(),
        program: None,
        state: "waiting".into(),
        since: need.since,
        machine: need.machine.clone().unwrap_or_default(),
        waiting: Some(Waiting {
            kind: need.kind.clone(),
            since: need.since,
            plan: need.plan.clone(),
            decide: need.decide,
        }),
        interrupt: false,
        device: device.to_string(),
    }
}

/// What waits on the person of an agent that does, as a list of agents says it.
fn need_of(agent: &Agent) -> Option<Need> {
    let waiting = agent
        .waiting
        .as_ref()
        .filter(|_| agent.waits_on_the_person())?;
    Some(Need {
        workspace: agent.workspace.clone(),
        name: agent.name.clone(),
        tile: agent.tile.clone(),
        agent: agent.agent.clone(),
        kind: waiting.kind.clone(),
        since: waiting.since,
        plan: waiting.plan.clone(),
        machine: Some(agent.machine.clone()),
        decide: waiting.decide,
    })
}

const HEARD: &str = "heard.json";
const AWAY: &str = "away.json";

impl Identity {
    /// What each of the person's devices last told this phone, by device: kept in `heard.json`
    /// beside its keys, readable by this user alone. What a phone of before kept says when its
    /// device answered as when it last told anything, which it did not keep apart.
    pub fn heard(&self) -> BTreeMap<String, Heard> {
        let mut heard: BTreeMap<String, Heard> = fs::read_to_string(self.dir().join(HEARD))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        for kept in heard.values_mut() {
            if kept.answer.is_some() && kept.answered.is_none() {
                kept.answered = Some(kept.at);
            }
        }
        heard
    }

    /// Keep what each device of `answers` answered, at `at`, in place of what it said before of
    /// what waits on the person, and of its agents: none of them is away.
    pub fn hear(&self, answers: &[(String, Answer)], at: u64) -> Result<()> {
        let devices: Vec<&str> = answers.iter().map(|(d, _)| d.as_str()).collect();
        self.heard_from(&devices, at, |device, heard| {
            let answered = answers.iter().rev().find(|(d, _)| d.as_str() == device);
            heard.answer = Some(answered.expect("one of those answering").1.clone());
            heard.answered = Some(at);
            heard.agents = None;
        })
    }

    /// Keep the agents `device` listed at `at` (spec/agents.md "Following"), and what waits on the
    /// person among them, in place of what it said before: it is not away.
    pub fn hear_agents(&self, device: &str, listed: &Listed, at: u64) -> Result<()> {
        self.heard_from(&[device], at, |_, heard| {
            heard.answer = Some(Answer {
                needs: listed.agents.iter().filter_map(need_of).collect(),
                working: listed.working,
            });
            heard.answered = Some(at);
            heard.agents = Some(listed.agents.clone());
        })
    }

    /// Keep the workspaces `device` said at `at` it holds: it is not away. What waits there it has
    /// not said by this.
    pub fn hear_workspaces(&self, device: &str, held: &[Held], at: u64) -> Result<()> {
        self.heard_from(&[device], at, |_, heard| heard.workspaces = held.to_vec())
    }

    /// Change what each of `devices` said, as heard at `at`: none of them is away.
    fn heard_from(
        &self,
        devices: &[&str],
        at: u64,
        mut said: impl FnMut(&str, &mut Heard),
    ) -> Result<()> {
        let mut heard = self.heard();
        for device in devices {
            let kept = heard.entry(device.to_string()).or_insert_with(|| Heard {
                at,
                answer: None,
                answered: None,
                agents: None,
                workspaces: vec![],
            });
            kept.at = at;
            said(device, kept);
        }
        write_heard(self, &heard)?;
        let mut away = self.away();
        let before = away.len();
        away.retain(|device, _| !devices.contains(&device.as_str()));
        if away.len() == before {
            return Ok(());
        }
        write_away(self, &away)
    }

    /// The person's devices this phone found away, and when it last did: each until it answers
    /// again, or says it is back since then (spec/push.md).
    pub fn away(&self) -> BTreeMap<String, u64> {
        fs::read_to_string(self.dir().join(AWAY))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    /// `devices` did not answer at `at`: found away then.
    pub fn mark_away(&self, devices: &[String], at: u64) -> Result<()> {
        if devices.is_empty() {
            return Ok(());
        }
        let mut away = self.away();
        for device in devices {
            away.insert(device.clone(), at);
        }
        write_away(self, &away)
    }

    /// `device` says it is back since `since`: whether this phone had found it away before then,
    /// and so shows it. It is not away from then on; one it found away after is, as a notice can
    /// come late.
    pub fn back(&self, device: &str, since: u64) -> Result<bool> {
        let mut away = self.away();
        if away.get(device).is_none_or(|&at| at > since) {
            return Ok(false);
        }
        away.remove(device);
        write_away(self, &away)?;
        Ok(true)
    }
}

fn write_away(identity: &Identity, away: &BTreeMap<String, u64>) -> Result<()> {
    write_private(
        &identity.dir().join(AWAY),
        &format!("{}\n", serde_json::to_string(away)?),
    )
}

/// Forget what `device` said, and that it was away; or that of every device.
pub(crate) fn forget_heard(identity: &Identity, device: Option<&str>) -> Result<()> {
    let (mut heard, mut away) = (identity.heard(), identity.away());
    let (had_heard, had_away) = (heard.len(), away.len());
    match device {
        Some(device) => {
            heard.remove(device);
            away.remove(device);
        }
        None => {
            heard.clear();
            away.clear();
        }
    }
    if heard.len() != had_heard {
        write_heard(identity, &heard)?;
    }
    if away.len() != had_away {
        write_away(identity, &away)?;
    }
    Ok(())
}

fn write_heard(identity: &Identity, heard: &BTreeMap<String, Heard>) -> Result<()> {
    write_private(
        &identity.dir().join(HEARD),
        &format!("{}\n", serde_json::to_string(heard)?),
    )
}
