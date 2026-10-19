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
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use std::convert::Infallible;

use tokio::sync::mpsc::{Receiver, Sender, UnboundedReceiver};

use crate::{devices, failure::Failure, keys, pairing::PairedWith};

/// The size a phone watches at: a viewer's never changes the session's.
const COLS: u32 = 80;
const ROWS: u32 = 24;

/// A workspace a device holds, as it says: its id, its name, and its folder there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Held {
    pub workspace: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, rename = "repo", skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
}

/// The workspaces the device on `connection` holds, as it says on its `device` stream: each that
/// names its id.
pub async fn held(connection: &Connection) -> Result<Vec<Held>> {
    let answer = devices::ask(connection, &json!({ "t": "workspaces" })).await?;
    let held = answer.get("workspaces").and_then(Value::as_array);
    Ok(held
        .into_iter()
        .flatten()
        .filter_map(|w| serde_json::from_value(w.clone()).ok())
        .collect())
}

/// Whether the device on `connection` holds `workspace`, as it says.
pub(crate) async fn holds(connection: &Connection, workspace: &str) -> Result<bool> {
    let held = held(connection).await?;
    Ok(held.iter().any(|w| w.workspace == workspace))
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
    pub(crate) send: SendStream,
    pub(crate) recv: RecvStream,
    /// The id the next call takes.
    pub(crate) next: u64,
}

impl Workspace {
    /// Open `workspace` on `connection`, to the device that holds it.
    pub async fn open(connection: &Connection, workspace: &str) -> Result<Self> {
        let (mut send, recv) = hive_net::ws::open(connection, "api").await?;
        let hello = json!({ "t": "open", "workspace": workspace, "z": crate::squeeze::OFFER });
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
        read_message(&mut self.recv).await
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

pub(crate) async fn read_message(recv: &mut RecvStream) -> Result<Option<Value>> {
    Ok(match read_frame(recv).await? {
        Some(frame) => Some(serde_json::from_slice(&crate::squeeze::unsqueezed(frame)?)?),
        None => None,
    })
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

/// How a watched session ended: its code; none when it had ended before it was watched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ended {
    pub code: Option<i64>,
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

/// What the phone sends a watched terminal: what the person types, the size the person fits it
/// to on the phone (none: the size it had before), the phone's own size, which the terminal
/// takes once the person types on the phone, or the lines of its scrollback to be sent its screen
/// again with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Sent {
    Typed(String),
    Fit(Option<(u16, u16)>),
    Size(u16, u16),
    History(usize),
}

/// What the person does to a watched terminal, as an app says it: text typed as it is, keys by
/// name (`keys.rs`), or a fit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Input {
    Text(String),
    Keys(Vec<String>),
    Fit(Option<(u16, u16)>),
    Size(u16, u16),
    History(usize),
}

/// What the person does, in order, for as long as `sent` takes it: keys as their bytes, a moment
/// apart.
pub async fn pass_on(inputs: &mut UnboundedReceiver<Input>, sent: Sender<Sent>) -> Infallible {
    while let Some(input) = inputs.recv().await {
        let sends = match input {
            Input::Text(text) => vec![Sent::Typed(text)],
            Input::Keys(keys) => keys
                .iter()
                .map(|k| Sent::Typed(keys::bytes(k).to_string()))
                .collect(),
            Input::Fit(size) => vec![Sent::Fit(size)],
            Input::Size(cols, rows) => vec![Sent::Size(cols, rows)],
            Input::History(lines) => vec![Sent::History(lines)],
        };
        for (i, one) in sends.into_iter().enumerate() {
            if i > 0 {
                n0_future::time::sleep(keys::GAP).await;
            }
            let _ = sent.send(one).await;
        }
    }
    std::future::pending().await
}

/// Watch the terminal of `tile` in `workspace`, on `connection` to the device that holds it: `out`
/// is handed its size and its screen, then each piece of its output, and its size and who holds
/// its keyboard as they change. Each frame of output taken is acknowledged, so the device sends
/// no more than its window ahead and, when this falls behind, the screen in place of what it
/// missed (spec/workspace-api.md, `terminal.ack`). With `sent`, what the person types goes into
/// it as it is, once its keyboard is asked for, as they first type: one someone else holds is
/// asked of them, and keys wait on nobody (spec/workspace-api.md, "Peers"); and a fit sizes it,
/// until the watch ends. How it ended; none when the connection went first.
pub async fn watch(
    connection: &Connection,
    workspace: &str,
    tile: &str,
    history: usize,
    mut sent: Option<Receiver<Sent>>,
    mut out: impl FnMut(Watched<'_>),
) -> Result<Option<Ended>> {
    let session = format!("hm:{tile}");
    let mut w = Workspace::open(connection, workspace).await?;
    let opened = w
        .ask(
            "terminal.open",
            json!([{
                "tileId": session, "tile": tile, "cwd": format!("hive://{workspace}"), "cmd": "",
                "cols": COLS, "rows": ROWS, "attachOnly": true, "liveOnly": true, "acks": true,
                "history": history,
            }]),
        )
        .await?;
    // What is typed and the acknowledgements go out while the output comes in. The stream stays
    // open until the watching ends, and goes with it: the device takes its end as the phone gone.
    let Workspace { send, mut recv, .. } = w;
    let send = tokio::sync::Mutex::new(send);
    let notify = |method: &str, params: Value| {
        let notice = json!({ "method": method, "params": params }).to_string();
        let send = &send;
        async move { write_frame(&mut *send.lock().await, notice.as_bytes()).await }
    };
    let sending = async {
        if let Some(sent) = sent.as_mut() {
            let mut asked = false;
            while let Some(one) = sent.recv().await {
                let written = match one {
                    Sent::Typed(data) => {
                        if !std::mem::replace(&mut asked, true) {
                            if notify("terminal.keyboard.ask", json!([session]))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        notify("terminal.write", json!([session, data])).await
                    }
                    Sent::Fit(Some((cols, rows))) => {
                        notify("terminal.fit", json!([session, cols, rows])).await
                    }
                    Sent::Fit(None) => notify("terminal.fit", json!([session])).await,
                    Sent::Size(cols, rows) => {
                        notify("terminal.resize", json!([session, cols, rows])).await
                    }
                    Sent::History(lines) => {
                        notify("terminal.history", json!([session, lines])).await
                    }
                };
                if written.is_err() {
                    break;
                }
            }
        }
        std::future::pending::<Result<Option<Ended>>>().await
    };
    let watched = async {
        // The output taken, in UTF-16 units as the device counts it, and how much was told.
        let (mut taken, mut told) = (0u64, 0u64);
        while let Some(message) = read_message(&mut recv).await? {
            // A moment's events come as one frame.
            let events = match message {
                Value::Array(events) => events,
                m if m.get("id").and_then(Value::as_u64) == Some(opened) => {
                    // Attached to no session: there is none.
                    if result_of(m)?.get("pid").and_then(Value::as_i64) == Some(-1) {
                        return Ok(Some(Ended { code: None }));
                    }
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
                            taken += data.encode_utf16().count() as u64;
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
                        return Ok(Some(Ended { code: Some(code) }));
                    }
                    _ => {}
                }
            }
            if taken > told {
                told = taken;
                notify("terminal.ack", json!([session, taken])).await?;
            }
        }
        Ok(None)
    };
    tokio::select! {
        watched = watched => watched,
        never = sending => never,
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
    /// Questions, each answered in order.
    Answers(Vec<Answer>),
}

/// The answer to one question: the options chosen, counting from 0, or a line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    Chosen(Vec<u32>),
    Text(String),
}

impl Reply {
    /// As `agent.answer` takes it: `{text}`, `{decision, feedback?}` or `{answers}`.
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
            Reply::Answers(answers) => json!({ "answers": answers.iter().map(|a| match a {
                Answer::Chosen(n) => json!({ "chosen": n }),
                Answer::Text(text) => json!({ "text": text }),
            }).collect::<Vec<_>>() }),
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

/// Answer someone asking to join `workspace`, the question `req` its device told of (spec/push.md
/// "Join"): let them in at their link's role, or turn them away. Whether the answer counted: not
/// when it was answered already, or nobody answered in time.
pub async fn let_in(
    connection: &Connection,
    workspace: &str,
    req: u64,
    allow: bool,
) -> Result<bool> {
    let mut w = Workspace::open(connection, workspace).await?;
    let result = w
        .call(
            "people.answer",
            json!([format!("hive://{workspace}"), req, allow]),
        )
        .await?;
    Ok(result.get("answered").and_then(Value::as_bool) == Some(true))
}

/// A message the computer took for an agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Taken {
    /// It waits for the agent's turn to end; else it was typed in.
    pub held: bool,
}

/// Send the agent of `tile` in `workspace` the message `text`: it is typed in as its next prompt
/// once it is at its prompt, or into its turn when it reads one there (spec/needs.md, "Sending").
/// None when no agent runs there.
pub async fn send(
    connection: &Connection,
    workspace: &str,
    tile: &str,
    text: &str,
) -> Result<Option<Taken>> {
    let mut w = Workspace::open(connection, workspace).await?;
    let result = w.call("agent.send", json!([tile, text])).await?;
    Ok(
        (result.get("sent").and_then(Value::as_bool) == Some(true)).then(|| Taken {
            held: result.get("held").and_then(Value::as_bool) == Some(true),
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reply_is_said_as_agent_answer_takes_it() {
        let said = [
            (Reply::Text("y".into()), json!({ "text": "y" })),
            (
                Reply::Decide { allow: false },
                json!({ "decision": "deny" }),
            ),
            (
                Reply::Plan {
                    approve: false,
                    feedback: Some("split it".into()),
                },
                json!({ "decision": "deny", "feedback": "split it" }),
            ),
            (
                Reply::Answers(vec![
                    Answer::Chosen(vec![2]),
                    Answer::Chosen(vec![0, 2]),
                    Answer::Text("Durian".into()),
                ]),
                json!({ "answers": [{ "chosen": [2] }, { "chosen": [0, 2] }, { "text": "Durian" }] }),
            ),
        ];
        for (reply, wire) in said {
            assert_eq!(reply.said(), wire, "{reply:?}");
        }
    }
}
