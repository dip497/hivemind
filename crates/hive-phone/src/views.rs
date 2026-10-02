//! Community views on the phone (docs/design/phone-app-2026-10-02.md §6.1, P8; spec/workspace-api.md
//! "Views on a remote screen", 0.14): the views the device that holds a workspace offers a phone,
//! their files as that device serves them to its own windows, and a view opened there, on the
//! phone's screen. Its host runs on that device: what the view posts goes to it, and the screen as
//! it changes, and what it says comes back, until the phone closes the view or the host ends it.
//! The phone relays; the checks and the limits are the host's.

use std::collections::BTreeMap;

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use hive_net::frames::{read_frame, write_frame};
use iroh::endpoint::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};

use crate::workspace::{result_of, Workspace};

/// A view the device offers a phone: its id, its name, its version, the file it starts from, and
/// the page a screen loads to show it (0.14): that file when it is a page, else a page made to run
/// it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Offered {
    pub id: String,
    pub name: String,
    pub version: String,
    pub entry: String,
    pub page: String,
}

/// One of a view's files, as the device serves it to its own windows: its bytes, its type
/// (`text/html; charset=utf-8`, …), and the Content-Security-Policy to serve it under, whose nonce
/// a page made for it carries (0.14).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewFile {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub csp: String,
}

/// Dark or light.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Dark,
    Light,
}

/// A view's fonts, by their families: for its words, and for code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Fonts {
    pub ui: String,
    pub mono: String,
}

/// The look the phone gives views, as the view protocol's `theme` has it: its colours by token
/// (`bg`, `fg`, …, each `#rrggbb`), and, as the app says them, dark or light, its accent, corner
/// radius in pixels, fonts, panel surface and terminal background, glass, and a colour for each
/// status tone.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    pub colors: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<Mode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub radius: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fonts: Option<Fonts>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surface: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_background: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub glass: Option<bool>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub status: BTreeMap<String, String>,
}

/// The screen a view is shown on: its size in CSS pixels, and its look (0.14).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Screen {
    pub w: u32,
    pub h: u32,
    pub theme: Theme,
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
    let said = |key: &str| answer.get(key).and_then(Value::as_str);
    let data = said("data").context("the device sent no file")?;
    let bytes = STANDARD
        .decode(data)
        .context("the device sent a file that is not base64")?;
    Ok(ViewFile {
        bytes,
        mime: said("type")
            .unwrap_or("application/octet-stream")
            .to_string(),
        // Served under no policy, a file of a view could reach the network: none is served.
        csp: said("csp")
            .context("the device sent a file with no policy to serve it under")?
            .to_string(),
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

/// A view opened on a workspace for this phone, its host on the device that holds the workspace.
pub struct Session {
    workspace: Workspace,
    id: String,
}

impl Session {
    /// Open the view `view` on `workspace`, on `connection` to the device that holds it, shown on
    /// `screen`; `surfaces`: the phone places the live surfaces the view asks for itself, and the
    /// view is told it does (workspace API 0.15; a device before it is told nothing of it).
    pub async fn open(
        connection: &Connection,
        workspace: &str,
        view: &str,
        screen: &Screen,
        surfaces: bool,
    ) -> Result<Self> {
        let mut w = Workspace::open(connection, workspace).await?;
        let params = match surfaces {
            true => json!([view, named(workspace), screen, true]),
            false => json!([view, named(workspace), screen]),
        };
        let opened = w.call("view.open", params).await?;
        let id = opened
            .get("session")
            .and_then(Value::as_str)
            .context("the device did not name the view's session")?
            .to_string();
        Ok(Self { workspace: w, id })
    }

    /// Relay the session: each message `posts` gives is posted to its host, and each screen
    /// `screen` changes to is told it; `said` is handed each message its host says to the view.
    /// Until `posts` ends, when the phone closes it, or until its host ends it. `again`: the view
    /// was shown on a session before this one, and starts again on this: until it says it is ready
    /// (its page loaded anew), what is posted is the page of before's, and is dropped. How it
    /// ended; an error when the connection went first.
    pub async fn relay(
        self,
        posts: &mut mpsc::Receiver<Value>,
        screen: &mut watch::Receiver<Screen>,
        again: bool,
        mut said: impl FnMut(Value),
    ) -> Result<Ended> {
        let Self {
            workspace:
                Workspace {
                    mut send,
                    mut recv,
                    next: closing,
                },
            id: session,
        } = self;
        // What goes to its host goes out while what it says comes in.
        let telling = async {
            let mut before = again;
            let mut sized = true;
            loop {
                let out = tokio::select! {
                    post = posts.recv() => match post {
                        Some(post) if before && post["type"] != "ready" => continue,
                        Some(post) => {
                            before = false;
                            json!({ "method": "view.post", "params": [session, post] })
                        }
                        None => break,
                    },
                    changed = screen.changed(), if sized => {
                        if changed.is_err() {
                            sized = false;
                            continue;
                        }
                        let now = screen.borrow_and_update().clone();
                        json!({ "method": "view.screen", "params": [session, now] })
                    }
                };
                write_frame(&mut send, out.to_string().as_bytes()).await?;
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
            failed = telling => failed,
        }
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
