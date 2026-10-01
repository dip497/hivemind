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

impl Identity {
    /// What each of the person's devices last answered this phone, by device: kept in
    /// `heard.json` beside its keys, readable by this user alone.
    pub fn heard(&self) -> BTreeMap<String, Heard> {
        fs::read_to_string(self.dir().join(HEARD))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    /// Keep what each device of `answers` answered, at `at`, in place of what it said before.
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
        write_heard(self, &heard)
    }
}

/// Forget what `device` said, or what every device said.
pub(crate) fn forget_heard(identity: &Identity, device: Option<&str>) -> Result<()> {
    let mut heard = identity.heard();
    match device {
        Some(device) if heard.remove(device).is_none() => return Ok(()),
        Some(_) => {}
        None if heard.is_empty() => return Ok(()),
        None => heard.clear(),
    }
    write_heard(identity, &heard)
}

fn write_heard(identity: &Identity, heard: &BTreeMap<String, Heard>) -> Result<()> {
    write_private(
        &identity.dir().join(HEARD),
        &format!("{}\n", serde_json::to_string(heard)?),
    )
}
