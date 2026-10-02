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

/// A piece of a conversation as a device sends it: its entries, how far into its session's file
/// they go, and that session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Piece {
    pub entries: Vec<Entry>,
    pub cursor: u64,
    pub session: String,
}

/// What the phone was handed of a conversation it follows, so that each piece is handed in order
/// and once: the pieces sent before the answer, after it; in a session, none that goes no further
/// than one handed already. A session begun since is handed whatever its cursors.
#[derive(Default)]
struct Handed {
    answered: bool,
    early: Vec<Piece>,
    last: Option<(String, u64)>,
}

impl Handed {
    /// The answer came: it, then what came before it, as far as they are new.
    fn answered(&mut self, answer: Piece) -> Vec<Piece> {
        self.answered = true;
        let early = std::mem::take(&mut self.early);
        std::iter::once(answer)
            .chain(early)
            .filter_map(|p| self.fresh(p))
            .collect()
    }

    /// A piece came: to hand now, if it is new, or once the answer has come.
    fn sent(&mut self, piece: Piece) -> Option<Piece> {
        if !self.answered {
            self.early.push(piece);
            return None;
        }
        self.fresh(piece)
    }

    /// `piece`, unless it goes no further in its session than one handed already.
    fn fresh(&mut self, piece: Piece) -> Option<Piece> {
        let stale = self
            .last
            .as_ref()
            .is_some_and(|(session, at)| *session == piece.session && piece.cursor < *at);
        if stale {
            return None;
        }
        self.last = Some((piece.session.clone(), piece.cursor));
        Some(piece)
    }
}

/// Follow the conversation of the agent of `tile` in `workspace`, on `connection` to the device
/// that holds it, from the cursor in the session `from` names (none, or a session the agent keeps
/// no more: the last of it): `said` is handed each piece, in order and once, until the device
/// closes the stream. A session the agent begins since comes from the last of it.
pub async fn follow(
    connection: &Connection,
    workspace: &str,
    tile: &str,
    from: Option<(&str, u64)>,
    mut said: impl FnMut(Piece),
) -> Result<()> {
    let mut w = Workspace::open(connection, workspace).await?;
    let params = match from {
        Some((session, cursor)) => json!([tile, cursor, session]),
        None => json!([tile]),
    };
    let asked = w.ask("agent.conversation", params).await?;
    let mut handed = Handed::default();
    loop {
        let Some(frame) = read_frame(&mut w.recv).await? else {
            return Ok(());
        };
        let message: Value = serde_json::from_slice(&frame)?;
        if message.get("id").and_then(Value::as_u64) == Some(asked) {
            let answer = crate::workspace::result_of(message)?;
            let cursor = answer
                .get("cursor")
                .and_then(Value::as_u64)
                .context("the device did not say how far the conversation goes")?;
            let session = answer.get("session").and_then(Value::as_str);
            let piece = Piece {
                entries: read_entries(&answer["entries"]),
                cursor,
                session: session.unwrap_or_default().to_string(),
            };
            handed.answered(piece).into_iter().for_each(&mut said);
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
            let at = |i: usize| params.and_then(|p| p.get(i));
            let (Some(about), Some(cursor), Some(session)) = (
                at(0).and_then(Value::as_str),
                at(2).and_then(Value::as_u64),
                at(3).and_then(Value::as_str),
            ) else {
                continue;
            };
            if about != tile {
                continue;
            }
            let piece = Piece {
                entries: read_entries(at(1).unwrap_or(&Value::Null)),
                cursor,
                session: session.to_string(),
            };
            handed.sent(piece).into_iter().for_each(&mut said);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn piece(n: u64, cursor: u64, session: &str) -> Piece {
        Piece {
            entries: vec![Entry {
                id: format!("u{n}"),
                at: n,
                who: "person".into(),
                text: Some(format!("prompt {n}")),
                tool: None,
                result: None,
            }],
            cursor,
            session: session.into(),
        }
    }

    fn cursors(pieces: &[Piece]) -> Vec<(u64, &str)> {
        pieces
            .iter()
            .map(|p| (p.cursor, p.session.as_str()))
            .collect()
    }

    #[test]
    fn what_a_device_sent_before_its_answer_is_handed_after_it_and_nothing_twice_in_a_session() {
        let mut handed = Handed::default();
        assert_eq!(handed.sent(piece(3, 300, "s1")), None);
        let first = handed.answered(piece(1, 200, "s1"));
        assert_eq!(cursors(&first), [(200, "s1"), (300, "s1")]);
        assert_eq!(
            handed.sent(piece(2, 250, "s1")),
            None,
            "older than one handed"
        );
        assert_eq!(handed.sent(piece(4, 400, "s1")), Some(piece(4, 400, "s1")));
    }

    #[test]
    fn a_session_begun_since_is_handed_from_its_start_its_cursors_its_own() {
        let mut handed = Handed::default();
        let _ = handed.answered(piece(1, 900, "s1"));
        assert_eq!(handed.sent(piece(5, 120, "s2")), Some(piece(5, 120, "s2")));
        assert_eq!(handed.sent(piece(6, 100, "s2")), None);
        assert_eq!(handed.sent(piece(7, 160, "s2")), Some(piece(7, 160, "s2")));
    }
}
