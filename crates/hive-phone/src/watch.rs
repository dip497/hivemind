//! Watching an agent's terminal from the phone (M5, design §9.2 "Watch"), read-only: the phone
//! opens the workspace's API on its own connection to the device that holds it (spec/workspace-api.md,
//! "Peers": a phone's `api` stream begins `{t:"open", workspace}`), as a viewer, and is sent the
//! terminal's screen and then its output as it comes, until the session ends or the phone stops.
//! Typing is not among what a phone may ask there.

use anyhow::{bail, Context, Result};
use hive_net::frames::{read_frame, write_frame};
use iroh::{endpoint::Connection, Endpoint};
use serde_json::{json, Value};

use crate::pairing::PairedWith;

/// The size a phone watches at: a viewer's never changes the session's.
const COLS: u32 = 80;
const ROWS: u32 = 24;

/// Whether the device on `connection` holds `workspace`, as it says on its `device` stream.
async fn holds(connection: &Connection, workspace: &str) -> Result<bool> {
    let (mut send, mut recv) = hive_net::ws::open(connection, "device").await?;
    write_frame(&mut send, br#"{"t":"workspaces"}"#).await?;
    loop {
        let frame = read_frame(&mut recv)
            .await?
            .context("the device closed without answering")?;
        let answer: Value = serde_json::from_slice(&frame)?;
        if let Some(held) = answer.get("workspaces").and_then(Value::as_array) {
            return Ok(held
                .iter()
                .any(|w| w.get("workspace").and_then(Value::as_str) == Some(workspace)));
        }
    }
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

/// How a watched session ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ended {
    pub code: i64,
}

/// Watch the terminal of `tile` in `workspace`, on `connection` to the device that holds it: `out`
/// is handed its screen, then each piece of its output. How it ended; none when the connection
/// went first.
pub async fn watch(
    connection: &Connection,
    workspace: &str,
    tile: &str,
    mut out: impl FnMut(&str),
) -> Result<Option<Ended>> {
    let session = format!("hm:{tile}");
    let (mut send, mut recv) = hive_net::ws::open(connection, "api").await?;
    let opening = [
        json!({ "t": "open", "workspace": workspace }),
        json!({ "id": 1, "method": "terminal.open", "params": [{
            "tileId": session, "tile": tile, "cwd": format!("hive://{workspace}"), "cmd": "", "cols": COLS, "rows": ROWS,
            "attachOnly": true, "liveOnly": true,
        }] }),
    ];
    for m in opening {
        write_frame(&mut send, m.to_string().as_bytes()).await?;
    }
    while let Some(frame) = read_frame(&mut recv).await? {
        let message: Value = serde_json::from_slice(&frame)?;
        // A moment's events come as one frame.
        let events = match message {
            Value::Array(events) => events,
            m if m.get("id").is_some() => {
                if let Some(error) = m.get("error") {
                    bail!(
                        "{}",
                        error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("the device refused")
                    );
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
                        out(data);
                    }
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
}
