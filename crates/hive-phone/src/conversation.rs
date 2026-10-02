//! What an agent and the person said to each other (spec/agents.md "Conversation", M5): the phone
//! asks the device that runs the agent, which reads the agent's session file, and is answered
//! what it says so far, then sent each piece written to it, until the phone stops. Held to
//! `conformance/conversation.json`.

use std::ops::Not;

use anyhow::{Context, Result};
use hive_net::frames::read_frame;
use iroh::endpoint::Connection;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};

use crate::workspace::Workspace;

/// A tool the agent used, and what its use is about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tool {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub about: Option<String>,
}

/// What a tool gave back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolResult {
    pub of: String,
    pub text: String,
    #[serde(
        default,
        deserialize_with = "only_true",
        skip_serializing_if = "Not::not"
    )]
    pub error: bool,
}

/// One thing said: by the person, by the agent (its text, in markdown, or a tool it used), or by
/// a tool (what it gave back).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    /// When, ms since the epoch.
    pub at: u64,
    /// `person`, `agent` or `tool`.
    pub who: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<Tool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<ToolResult>,
}

impl Entry {
    /// Whether it says what its `who` says: the person's text, the agent's text or tool, a tool's
    /// result.
    fn whole(&self) -> bool {
        match self.who.as_str() {
            "person" => self.text.is_some() && self.tool.is_none() && self.result.is_none(),
            "agent" => self.text.is_some() != self.tool.is_some() && self.result.is_none(),
            "tool" => self.result.is_some() && self.text.is_none() && self.tool.is_none(),
            _ => false,
        }
    }
}

/// `true` as itself; anything else as not said.
fn only_true<'de, D: Deserializer<'de>>(said: D) -> Result<bool, D::Error> {
    Ok(Value::deserialize(said)? == Value::Bool(true))
}

/// The entries in `entries` the phone can read, in the order sent.
pub fn read_entries(entries: &Value) -> Vec<Entry> {
    entries
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|e| serde_json::from_value::<Entry>(e.clone()).ok())
                .filter(Entry::whole)
                .collect()
        })
        .unwrap_or_default()
}

/// Follow the conversation of the agent of `tile` in `workspace`, on `connection` to the device that
/// holds it, from `cursor` (none: the last of it): `said` is handed each piece, with how far into
/// the agent's session file it goes, until the device closes the stream.
pub async fn follow(
    connection: &Connection,
    workspace: &str,
    tile: &str,
    cursor: Option<u64>,
    mut said: impl FnMut(Vec<Entry>, u64),
) -> Result<()> {
    let mut w = Workspace::open(connection, workspace).await?;
    let params = match cursor {
        Some(c) => json!([tile, c]),
        None => json!([tile]),
    };
    let asked = w.ask("agent.conversation", params).await?;
    // What comes after the answer may be sent before it: each piece is told as it comes.
    let mut furthest = 0u64;
    let mut hand = |entries: Vec<Entry>, at: u64| {
        if at >= furthest {
            furthest = at;
            said(entries, at);
        }
    };
    loop {
        let Some(frame) = read_frame(&mut w.recv).await? else {
            return Ok(());
        };
        let message: Value = serde_json::from_slice(&frame)?;
        if message.get("id").and_then(Value::as_u64) == Some(asked) {
            let answer = crate::workspace::result_of(message)?;
            let at = answer
                .get("cursor")
                .and_then(Value::as_u64)
                .context("the device did not say how far the conversation goes")?;
            hand(read_entries(&answer["entries"]), at);
            continue;
        }
        let events = match message {
            Value::Array(events) => events,
            m => vec![m],
        };
        for e in events {
            if e.get("event").and_then(Value::as_str) != Some("agent.said") {
                continue;
            }
            let params = e.get("params").and_then(Value::as_array);
            let about = params.and_then(|p| p.first()).and_then(Value::as_str);
            let at = params.and_then(|p| p.get(2)).and_then(Value::as_u64);
            if let (Some(_), Some(at)) = (about.filter(|t| *t == tile), at) {
                hand(read_entries(&params.unwrap()[1]), at);
            }
        }
    }
}
