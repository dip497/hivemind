//! Notes left on a page in a Browser tile on the computer: review comments on a page
//! (core's `review.ts`). The phone lists a workspace's, closes or reopens one, and sends the open
//! ones to an agent, in the words the computer writes for it (`review.message`).

use anyhow::Result;
use iroh::endpoint::Connection;
use serde::Serialize;
use serde_json::{json, Value};

use crate::workspace::Workspace;

/// A note as the phone shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Note {
    pub id: String,
    pub body: String,
    /// `open`, `seen` (an agent is on it), `resolved` or `dismissed`: core's `statusOf`.
    pub status: &'static str,
    /// What it points at: the first element's name, or "Area".
    pub what: String,
    pub url: String,
    /// What was done, or why it was dismissed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// The agent that left it; none when the person did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// The names of the files kept on it as proof, which stay on the computer.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<String>,
}

/// The notes on pages among a workspace's review comments, as `review.list` gives them.
pub fn read_notes(comments: &Value) -> Vec<Note> {
    let text = |c: &Value, k: &str| c.get(k).and_then(Value::as_str).map(str::to_owned);
    let yes = |c: &Value, k: &str| c.get(k).and_then(Value::as_bool) == Some(true);
    comments
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let page = c.get("page")?;
            let status = match (yes(c, "resolved"), yes(c, "dismissed"), yes(c, "seen")) {
                (true, true, _) => "dismissed",
                (true, false, _) => "resolved",
                (false, _, true) => "seen",
                _ => "open",
            };
            let what = if page.get("area").is_some() {
                "Area".to_owned()
            } else {
                page.pointer("/elements/0/name")?.as_str()?.to_owned()
            };
            Some(Note {
                id: text(c, "id")?,
                body: text(c, "body")?,
                status,
                what,
                url: text(page, "url")?,
                summary: text(c, "summary"),
                agent: text(c, "author").filter(|a| a != "you"),
                attachments: c
                    .get("attachments")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|n| n.as_str().map(str::to_owned))
                    .collect(),
            })
        })
        .collect()
}

/// The notes on pages kept in `repo`, a folder of `workspace`.
pub async fn notes(connection: &Connection, workspace: &str, repo: &str) -> Result<Vec<Note>> {
    let mut w = Workspace::open(connection, workspace).await?;
    Ok(read_notes(&w.call("review.list", json!([repo])).await?))
}

/// What the person does with a note from the phone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    Done,
    Dismiss(String),
    Reopen,
}

/// Close or reopen the note `id`; the computer refuses one not where that starts from.
pub async fn change(
    connection: &Connection,
    workspace: &str,
    repo: &str,
    id: &str,
    change: Change,
) -> Result<()> {
    let mut w = Workspace::open(connection, workspace).await?;
    let (method, params) = match change {
        Change::Done => ("review.resolve", json!([repo, id])),
        Change::Dismiss(reason) => ("review.dismiss", json!([repo, id, reason])),
        Change::Reopen => ("review.reopen", json!([repo, id])),
    };
    w.call(method, params).await?;
    Ok(())
}

/// Send the notes `ids` to the agent of `tile`, with how to answer them. Whether it took them.
pub async fn send(
    connection: &Connection,
    workspace: &str,
    repo: &str,
    ids: &[String],
    tile: &str,
) -> Result<bool> {
    let mut w = Workspace::open(connection, workspace).await?;
    let Some(text) = w
        .call("review.message", json!([repo, ids]))
        .await?
        .as_str()
        .map(str::to_owned)
    else {
        return Ok(false);
    };
    let sent = w.call("agent.send", json!([tile, text])).await?;
    Ok(sent.get("sent").and_then(Value::as_bool) == Some(true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_notes_on_pages_are_read_with_where_each_stands_and_a_diff_comment_is_left_out() {
        let listed = json!([
            { "id": "c-1", "body": "bigger", "page": { "url": "http://x/", "elements": [{ "name": "button \"Go\"" }] } },
            { "id": "c-2", "body": "crowded", "seen": true, "page": { "url": "http://x/", "area": { "x": 0 }, "elements": [] } },
            { "id": "c-3", "body": "done", "resolved": true, "summary": "now 48px", "page": { "url": "http://x/", "elements": [{ "name": "link \"Docs\"" }] } },
            { "id": "c-4", "body": "no", "resolved": true, "dismissed": true, "summary": "by design", "page": { "url": "http://x/", "elements": [{ "name": "img" }] } },
            { "id": "c-5", "body": "rename", "file": "a.ts", "startLine": 1, "endLine": 1 }
        ]);
        let notes = read_notes(&listed);
        let seen: Vec<_> = notes
            .iter()
            .map(|n| (n.id.as_str(), n.status, n.what.as_str()))
            .collect();
        assert_eq!(
            seen,
            vec![
                ("c-1", "open", "button \"Go\""),
                ("c-2", "seen", "Area"),
                ("c-3", "resolved", "link \"Docs\""),
                ("c-4", "dismissed", "img"),
            ]
        );
        assert_eq!(notes[2].summary.as_deref(), Some("now 48px"));
    }

    #[test]
    fn a_note_says_which_agent_left_it_and_what_files_it_keeps_and_the_persons_says_neither() {
        let listed = json!([
            { "id": "c-1", "body": "broken", "author": "pi #2", "attachments": ["c-1-1.webm", "c-1-2.png"], "page": { "url": "http://x/", "elements": [{ "name": "img" }] } },
            { "id": "c-2", "body": "bigger", "author": "you", "page": { "url": "http://x/", "elements": [{ "name": "img" }] } }
        ]);
        let notes = read_notes(&listed);
        assert_eq!(notes[0].agent.as_deref(), Some("pi #2"));
        assert_eq!(notes[0].attachments, ["c-1-1.webm", "c-1-2.png"]);
        assert_eq!(notes[1].agent, None);
        let shown = serde_json::to_value(&notes[1]).unwrap();
        assert!(shown.get("agent").is_none() && shown.get("attachments").is_none());
    }
}
