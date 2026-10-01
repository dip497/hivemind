//! What waits on the person (spec/needs.md, M5): the phone asks each of the person's devices it
//! knows, which work it out from the agents they run, and shows the lists as one, the one waiting
//! longest first. Held to `conformance/needs.json`.

use std::time::Duration;

use anyhow::{Context, Result};
use hive_net::frames::{read_frame, write_frame};
use iroh::Endpoint;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::pairing::PairedWith;

/// How long a device has to answer before it is said to be away.
const ANSWER_WITHIN: Duration = Duration::from_secs(10);

/// What an agent can wait on the person for.
const KINDS: [&str; 5] = ["permission", "question", "plan", "approval", "other"];

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

/// What a device's `answer` says waits on the person: each item that says all it must, as the
/// device ordered them. Anything that is not an answer says nothing.
pub fn read_answer(answer: &Value) -> Vec<Need> {
    if answer.get("t").and_then(Value::as_str) != Some("needs") {
        return vec![];
    }
    let Some(items) = answer.get("needs").and_then(Value::as_array) else {
        return vec![];
    };
    items
        .iter()
        .filter_map(|item| serde_json::from_value::<Need>(item.clone()).ok())
        .filter(|need| KINDS.contains(&need.kind.as_str()))
        .collect()
}

/// The lists of several devices as one: the one waiting longest first, and of two waiting since
/// the same moment, the one whose tile comes first.
pub fn as_one(lists: Vec<Vec<Need>>) -> Vec<Need> {
    let mut all: Vec<Need> = lists.into_iter().flatten().collect();
    all.sort_by(|a, b| a.since.cmp(&b.since).then_with(|| a.tile.cmp(&b.tile)));
    all
}

/// Ask `device`, from this phone's `endpoint`, what waits on the person there.
pub async fn ask(endpoint: &Endpoint, device: &PairedWith) -> Result<Vec<Need>> {
    let asked = async {
        let at = hive_net::net::addr_of(&device.device, &device.addrs, &device.relay)?;
        let connection = endpoint.connect(at, hive_net::ws::ALPN).await?;
        let (mut send, mut recv) = hive_net::ws::open(&connection, "device").await?;
        write_frame(&mut send, br#"{"t":"needs"}"#).await?;
        let needs = loop {
            let frame = read_frame(&mut recv)
                .await?
                .context("the device closed without answering")?;
            let answer: Value = serde_json::from_slice(&frame)?;
            if answer.get("t").and_then(Value::as_str) == Some("needs") {
                break read_answer(&answer);
            }
        };
        connection.close(0u32.into(), b"done");
        Ok::<_, anyhow::Error>(needs)
    };
    tokio::time::timeout(ANSWER_WITHIN, asked)
        .await
        .map_err(|_| anyhow::anyhow!("{} did not answer", device.name))?
}
