//! What waits on the person (spec/needs.md, M5): the phone asks each of the person's devices it
//! knows, which work it out from the agents they run, and shows the lists as one, the one waiting
//! longest first, with how many agents are at work on them; of a device that is away, what it last
//! answered and when. Held to `conformance/needs.json`.

use std::{collections::BTreeMap, fs};

use anyhow::Result;
use iroh::Endpoint;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    devices::{self, ANSWER_WITHIN},
    identity::{write_private, Identity},
    pairing::PairedWith,
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
}

/// What a device answers: what waits on the person there, and how many agents are at work there.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Answer {
    pub needs: Vec<Need>,
    pub working: u64,
}

/// What a device's `answer` says: what waits on the person, each item that says all it must, as
/// the device ordered them, and how many agents are at work (none when it does not say, or says
/// it as anything but a whole number of none or more). Anything that is not an answer says
/// nothing.
pub fn read_answer(answer: &Value) -> Answer {
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
        let answer = devices::ask(&connection, &json!({ "t": "needs" })).await?;
        connection.close(0u32.into(), b"done");
        Ok::<_, anyhow::Error>(read_answer(&answer))
    };
    tokio::time::timeout(ANSWER_WITHIN, asked)
        .await
        .map_err(|_| anyhow::anyhow!("{} did not answer", device.name))?
}

/// What a device last answered this phone, and when (ms since the epoch).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Heard {
    pub at: u64,
    #[serde(flatten)]
    pub answer: Answer,
}

const HEARD: &str = "heard.json";
const AWAY: &str = "away.json";

impl Identity {
    /// What each of the person's devices last answered this phone, by device: kept in
    /// `heard.json` beside its keys, readable by this user alone.
    pub fn heard(&self) -> BTreeMap<String, Heard> {
        fs::read_to_string(self.dir().join(HEARD))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    /// Keep what each device of `answers` answered, at `at`, in place of what it said before:
    /// none of them is away.
    pub fn hear(&self, answers: &[(String, Answer)], at: u64) -> Result<()> {
        let mut heard = self.heard();
        for (device, answer) in answers {
            heard.insert(
                device.clone(),
                Heard {
                    at,
                    answer: answer.clone(),
                },
            );
        }
        write_heard(self, &heard)?;
        let mut away = self.away();
        let before = away.len();
        away.retain(|device, _| !answers.iter().any(|(d, _)| d == device));
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
