//! One workspace's API, as a phone uses it on its own connection to the device that holds it
//! (spec/workspace-api.md, "Peers": the `api` stream begins `{t:"open", workspace}`): to watch an
//! agent's terminal and type into it (M5, design §9.2 "Watch"), to answer what an agent waits on
//! the person for (spec/needs.md, "Answering") and to send one a message ("Sending"). Nothing else
//! is open to a phone there.

use anyhow::{bail, Context, Result};
use hive_net::frames::{read_frame, write_frame};
use iroh::{
    endpoint::{Connection, RecvStream, SendStream},
    Endpoint,
};
use serde_json::{json, Value};

use tokio::sync::mpsc::Receiver;

use crate::{devices, failure::Failure, pairing::PairedWith};

/// The size a phone watches at: a viewer's never changes the session's.
const COLS: u32 = 80;
const ROWS: u32 = 24;

/// Whether the device on `connection` holds `workspace`, as it says on its `device` stream.
pub(crate) async fn holds(connection: &Connection, workspace: &str) -> Result<bool> {
    let answer = devices::ask(connection, &json!({ "t": "workspaces" })).await?;
    let held = answer.get("workspaces").and_then(Value::as_array);
    Ok(held.is_some_and(|held| {
        held.iter()
            .any(|w| w.get("workspace").and_then(Value::as_str) == Some(workspace))
    }))
}

/// A connection to the one of `devices` that holds `workspace`.
pub async fn holder(
    endpoint: &Endpoint,
    devices: &[PairedWith],
    workspace: &str,
) -> Result<Connection> {
    for device in devices {
        let Ok(at) = hive_net::net::addr_of(&device.device, &device.addrs, &device.relay) else {
            continue;
        };
        let Ok(connection) = endpoint.connect(at, hive_net::ws::ALPN).await else {
            continue;
        };
        if holds(&connection, workspace).await.unwrap_or(false) {
            return Ok(connection);
        }
        connection.close(0u32.into(), b"done");
    }
    bail!("none of your devices this phone reaches holds that workspace")
}

/// A workspace opened on a connection: calls go out, and answers and events come back.
pub struct Workspace {
    send: SendStream,
    pub(crate) recv: RecvStream,
    next: u64,
}

impl Workspace {
    /// Open `workspace` on `connection`, to the device that holds it.
    pub async fn open(connection: &Connection, workspace: &str) -> Result<Self> {
        let (mut send, recv) = hive_net::ws::open(connection, "api").await?;
        let hello = json!({ "t": "open", "workspace": workspace });
        write_frame(&mut send, hello.to_string().as_bytes()).await?;
        Ok(Self {
            send,
            recv,
            next: 1,
        })
    }

    /// Ask `method`; its answer comes later, after the events the call brings. Its id.
    pub(crate) async fn ask(&mut self, method: &str, params: Value) -> Result<u64> {
        let id = self.next;
        self.next += 1;
        let call = json!({ "id": id, "method": method, "params": params });
        write_frame(&mut self.send, call.to_string().as_bytes()).await?;
        Ok(id)
    }

    /// The next message: an answer, or one or more events. None once the device closed it.
    async fn message(&mut self) -> Result<Option<Value>> {
        Ok(match read_frame(&mut self.recv).await? {
            Some(frame) => Some(serde_json::from_slice(&frame)?),
            None => None,
        })
    }

    /// Ask `method` and wait for its result; the events that come meanwhile go unread.
    pub(crate) async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.ask(method, params).await?;
        loop {
            let message = self
                .message()
                .await?
                .context("the device closed without answering")?;
            if message.get("id").and_then(Value::as_u64) == Some(id) {
                return result_of(message);
            }
        }
    }
}

/// An answer's result, or why it was refused.
pub(crate) fn result_of(answer: Value) -> Result<Value> {
    if let Some(error) = answer.get("error") {
        let said = |key: &str| error.get(key).and_then(Value::as_str);
        return Err(Failure::Refused {
            code: said("code").map(str::to_string),
            message: said("message").unwrap_or("the device refused").to_string(),
        }
        .into());
    }
    Ok(answer.get("result").cloned().unwrap_or(Value::Null))
}

/// How a watched session ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ended {
    pub code: i64,
}

/// What happens in a watched terminal: a piece of its output, the size it took, or its keyboard
/// changing hands.
pub enum Watched<'a> {
    Output(&'a str),
    /// The size its session took, its columns and rows: the phone draws it at that size, and never
    /// sizes it.
    Size(u16, u16),
    /// Who holds its keyboard now, `{id, person, name}`: `None` while the person's own devices
    /// do, and the phone types into it as they do.
    Keyboard(Option<&'a Value>),
}

/// Watch the terminal of `tile` in `workspace`, on `connection` to the device that holds it: `out`
/// is handed its size and its screen, then each piece of its output, and its size and who holds
/// its keyboard as they change. With `typed`, what the person types goes into it as it is, once
/// its keyboard is asked for, as they first type: one someone else holds is asked of them, and
/// keys wait on nobody (spec/workspace-api.md, "Peers"). How it ended; none when the connection
/// went first.
pub async fn watch(
    connection: &Connection,
    workspace: &str,
    tile: &str,
    mut typed: Option<Receiver<String>>,
    mut out: impl FnMut(Watched<'_>),
) -> Result<Option<Ended>> {
    let session = format!("hm:{tile}");
    let mut w = Workspace::open(connection, workspace).await?;
    let opened = w
        .ask(
            "terminal.open",
            json!([{
                "tileId": session, "tile": tile, "cwd": format!("hive://{workspace}"), "cmd": "",
                "cols": COLS, "rows": ROWS, "attachOnly": true, "liveOnly": true,
            }]),
        )
        .await?;
    // What is typed goes out while the output comes in. The stream stays open until the watching
    // ends, and goes with it: the device takes its end as the phone gone.
    let Workspace {
        mut send, mut recv, ..
    } = w;
    let typing = async {
        if let Some(typed) = typed.as_mut() {
            let mut asked = false;
            'typing: while let Some(data) = typed.recv().await {
                let mut notices = vec![];
                if !std::mem::replace(&mut asked, true) {
                    notices.push(json!({ "method": "terminal.keyboard.ask", "params": [session] }));
                }
                notices.push(json!({ "method": "terminal.write", "params": [session, data] }));
                for notice in notices {
                    if write_frame(&mut send, notice.to_string().as_bytes())
                        .await
                        .is_err()
                    {
                        break 'typing;
                    }
                }
            }
        }
        std::future::pending::<Result<Option<Ended>>>().await
    };
    let watched = async {
        while let Some(frame) = read_frame(&mut recv).await? {
            // A moment's events come as one frame.
            let events = match serde_json::from_slice::<Value>(&frame)? {
                Value::Array(events) => events,
                m if m.get("id").and_then(Value::as_u64) == Some(opened) => {
                    result_of(m)?;
                    continue;
                }
                m => vec![m],
            };
            for e in events {
                let params = e.get("params").and_then(Value::as_array);
                let about = params.and_then(|p| p.first()).and_then(Value::as_str);
                if about != Some(session.as_str()) {
                    continue;
                }
                match e.get("event").and_then(Value::as_str) {
                    Some("terminal.data") => {
                        if let Some(data) = params.and_then(|p| p.get(1)).and_then(Value::as_str) {
                            out(Watched::Output(data));
                        }
                    }
                    Some("terminal.size") => {
                        let size = |i| {
                            let n = params.and_then(|p| p.get(i)).and_then(Value::as_u64)?;
                            Some(u16::try_from(n).unwrap_or(u16::MAX))
                        };
                        if let (Some(cols), Some(rows)) = (size(1), size(2)) {
                            out(Watched::Size(cols, rows));
                        }
                    }
                    Some("terminal.keyboard") => {
                        let holder = params.and_then(|p| p.get(1)).filter(|h| h.is_object());
                        out(Watched::Keyboard(holder));
                    }
                    Some("terminal.exit") => {
                        let code = params
                            .and_then(|p| p.get(1))
                            .and_then(|i| i.get("code"))
                            .and_then(Value::as_i64)
                            .unwrap_or(0);
                        return Ok(Some(Ended { code }));
                    }
                    _ => {}
                }
            }
        }
        Ok(None)
    };
    tokio::select! {
        watched = watched => watched,
        never = typing => never,
    }
}

/// What the person answers an agent that waits on them (spec/needs.md, "Answering").
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reply {
    /// A line, typed into its terminal, Enter after it.
    Text(String),
    /// A permission its device can decide, allowed or denied with the agent's own keys.
    Decide { allow: bool },
    /// A plan, approved, or sent back with what to change in it.
    Plan {
        approve: bool,
        feedback: Option<String>,
    },
}

impl Reply {
    /// As `agent.answer` takes it: `{text}`, or `{decision, feedback?}`.
    fn said(&self) -> Value {
        let decision = |yes: bool| if yes { "allow" } else { "deny" };
        match self {
            Reply::Text(text) => json!({ "text": text }),
            Reply::Decide { allow } => json!({ "decision": decision(*allow) }),
            Reply::Plan {
                approve,
                feedback: Some(feedback),
            } => json!({ "decision": decision(*approve), "feedback": feedback }),
            Reply::Plan { approve, .. } => json!({ "decision": decision(*approve) }),
        }
    }
}

/// Answer what the agent of `tile` in `workspace` waits on the person for, the wait that began at
/// `since`, with `reply`. Whether it landed: not when the agent waits on that no more, or it was
/// answered.
pub async fn answer(
    connection: &Connection,
    workspace: &str,
    tile: &str,
    since: u64,
    reply: &Reply,
) -> Result<bool> {
    let mut w = Workspace::open(connection, workspace).await?;
    let result = w
        .call("agent.answer", json!([tile, since, reply.said()]))
        .await?;
    Ok(result.get("answered").and_then(Value::as_bool) == Some(true))
}

/// Send the agent of `tile` in `workspace` the message `text`, one line: it is typed in as its next
/// prompt once it is at its prompt (spec/needs.md, "Sending"). Whether it went: not when no agent
/// runs there.
pub async fn send(
    connection: &Connection,
    workspace: &str,
    tile: &str,
    text: &str,
) -> Result<bool> {
    let mut w = Workspace::open(connection, workspace).await?;
    let result = w.call("agent.send", json!([tile, text])).await?;
    Ok(result.get("sent").and_then(Value::as_bool) == Some(true))
}
