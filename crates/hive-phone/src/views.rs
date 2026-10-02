//! Community views on the phone (docs/design/phone-app-2026-10-02.md §6.1, P8; spec/workspace-api.md
//! "Views on a remote screen"): the views the device that holds a workspace offers a phone, their
//! files, and a view opened there. Its host runs on that device: what the view posts goes to it, and
//! what it says comes back, until the phone closes the view or the host ends it. The phone relays;
//! the checks and the limits are the host's.

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use hive_net::frames::{read_frame, write_frame};
use iroh::endpoint::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc::Receiver;

use crate::workspace::{result_of, Workspace};

/// A view the device offers a phone: its id, its name, its version, and the file it starts from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Offered {
    pub id: String,
    pub name: String,
    pub version: String,
    pub entry: String,
}

/// One of a view's files: its bytes, and its type (`text/html; charset=utf-8`, …).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewFile {
    pub bytes: Vec<u8>,
    pub mime: String,
}

/// How a view's session ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ended {
    /// The phone closed it.
    Closed,
    /// Its host ended it, and why: it disabled the view.
    Host(String),
}

/// How a peer names the workspace `workspace` to the device that holds it.
fn named(workspace: &str) -> String {
    format!("hive://{workspace}")
}

/// The views the device on `connection`, which holds `workspace`, offers a phone.
pub async fn list(connection: &Connection, workspace: &str) -> Result<Vec<Offered>> {
    let mut w = Workspace::open(connection, workspace).await?;
    let answer = w.call("view.list", json!([])).await?;
    serde_json::from_value(answer)
        .context("the device said which views it offers in a way not understood")
}

/// The file at `path` in the view `view`, from the device on `connection`, which holds `workspace`.
pub async fn file(
    connection: &Connection,
    workspace: &str,
    view: &str,
    path: &str,
) -> Result<ViewFile> {
    let mut w = Workspace::open(connection, workspace).await?;
    let answer = w.call("view.file", json!([view, path])).await?;
    let data = answer
        .get("data")
        .and_then(Value::as_str)
        .context("the device sent no file")?;
    let bytes = STANDARD
        .decode(data)
        .context("the device sent a file that is not base64")?;
    let mime = answer.get("type").and_then(Value::as_str);
    Ok(ViewFile {
        bytes,
        mime: mime.unwrap_or("application/octet-stream").to_string(),
    })
}

/// What the device says of a view session.
#[derive(Debug, Clone, PartialEq)]
enum Heard {
    /// Its host said this to the view.
    Said(Value),
    /// Its host ended it, and why.
    Ended(String),
}

/// What `message`, one event or a moment's list of them, says of the session `session`, in order.
fn heard(message: Value, session: &str) -> Vec<Heard> {
    let events = match message {
        Value::Array(events) => events,
        m => vec![m],
    };
    events
        .into_iter()
        .filter_map(|mut e| {
            let event = e.get("event")?.as_str()?.to_string();
            let params = e.get_mut("params")?.as_array_mut()?;
            if params.first()?.as_str()? != session {
                return None;
            }
            let what = params.get_mut(1)?.take();
            match event.as_str() {
                "view.said" => Some(Heard::Said(what)),
                "view.ended" => Some(Heard::Ended(what.as_str().unwrap_or_default().to_string())),
                _ => None,
            }
        })
        .collect()
}

/// Open the view `view` on `workspace`, on `connection` to the device that holds it: `said` is
/// handed each message its host says to it, and each message `posts` gives is posted to its host,
/// until `posts` ends, when the phone closes it, or until its host ends it. How it ended; an error
/// when the connection went first.
pub async fn open(
    connection: &Connection,
    workspace: &str,
    view: &str,
    mut posts: Receiver<Value>,
    mut said: impl FnMut(Value),
) -> Result<Ended> {
    let mut w = Workspace::open(connection, workspace).await?;
    let opened = w.call("view.open", json!([view, named(workspace)])).await?;
    let session = opened
        .get("session")
        .and_then(Value::as_str)
        .context("the device did not name the view's session")?
        .to_string();
    // What the view posts goes out while what its host says comes in.
    let Workspace {
        mut send,
        mut recv,
        next: closing,
    } = w;
    let posting = async {
        while let Some(message) = posts.recv().await {
            let post = json!({ "method": "view.post", "params": [session, message] });
            write_frame(&mut send, post.to_string().as_bytes()).await?;
        }
        let close = json!({ "id": closing, "method": "view.close", "params": [session] });
        write_frame(&mut send, close.to_string().as_bytes()).await?;
        std::future::pending::<Result<Ended>>().await
    };
    let hearing = async {
        while let Some(frame) = read_frame(&mut recv).await? {
            let message: Value = serde_json::from_slice(&frame)?;
            if message.get("id").and_then(Value::as_u64) == Some(closing) {
                result_of(message)?;
                return Ok(Ended::Closed);
            }
            for h in heard(message, &session) {
                match h {
                    Heard::Said(message) => said(message),
                    Heard::Ended(why) => return Ok(Ended::Host(why)),
                }
            }
        }
        bail!("the device closed the connection")
    };
    tokio::select! {
        ended = hearing => ended,
        failed = posting => failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_a_device_says_of_a_session_is_heard_in_order_and_of_no_other_session() {
        let moment = json!([
            { "event": "view.said", "params": ["s1", { "type": "hello" }] },
            { "event": "view.said", "params": ["s2", { "type": "structure" }] },
            { "event": "status.changed", "params": [{ "tileId": "t1" }] },
            { "event": "view.ended", "params": ["s1", "8 malformed or unauthorised messages"] },
        ]);
        assert_eq!(
            heard(moment, "s1"),
            [
                Heard::Said(json!({ "type": "hello" })),
                Heard::Ended("8 malformed or unauthorised messages".into())
            ]
        );
        let one = json!({ "event": "view.said", "params": ["s1", { "type": "names" }] });
        assert_eq!(heard(one, "s1"), [Heard::Said(json!({ "type": "names" }))]);
    }
}
