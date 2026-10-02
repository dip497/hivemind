//! Driving the person's agents from the phone (spec/agents.md, M5): what may be started in a
//! workspace, starting an agent there, interrupting its turn, closing it, and what it changed. Each
//! is a call of the workspace API on the phone's connection to the device that holds the workspace,
//! which carries it out as the person.

use anyhow::{Context, Result};
use iroh::endpoint::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::workspace::Workspace;

/// One of an agent's launch choices: `model` or `mode`, with the values it lists (none: taken as
/// typed).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartOption {
    pub id: String,
    pub label: String,
    pub values: Vec<String>,
}

/// An agent the device starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartProgram {
    pub id: String,
    pub label: String,
    pub options: Vec<StartOption>,
}

/// A frame of the workspace: a folder to start an agent in, and the machine it is on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Frame {
    pub id: String,
    pub name: String,
    pub machine: String,
}

/// What may be started in a workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Startable {
    pub programs: Vec<StartProgram>,
    pub frames: Vec<Frame>,
}

/// An agent to start: which, where, and with what.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Start {
    pub program: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

/// A file an agent changed: its status letter, and the lines the patch adds and removes in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangedFile {
    pub path: String,
    pub status: String,
    pub added: u32,
    pub removed: u32,
}

/// What an agent changed in the folder it runs in, against its last commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Changes {
    pub files: Vec<ChangedFile>,
    pub patch: String,
    pub truncated: bool,
}

/// How a peer names the workspace `workspace` to the device that holds it.
fn named(workspace: &str) -> String {
    format!("hive://{workspace}")
}

/// What may be started in `workspace`, on `connection` to the device that holds it.
pub async fn startable(connection: &Connection, workspace: &str) -> Result<Startable> {
    let mut w = Workspace::open(connection, workspace).await?;
    let answer = w.call("agent.startable", json!([named(workspace)])).await?;
    serde_json::from_value(answer)
        .context("the device said what may be started in a way not understood")
}

/// Start an agent in `workspace` as `start` says: its tile.
pub async fn start(connection: &Connection, workspace: &str, start: &Start) -> Result<String> {
    let mut w = Workspace::open(connection, workspace).await?;
    let answer = w
        .call("agent.start", json!([named(workspace), start]))
        .await?;
    answer
        .get("tile")
        .and_then(Value::as_str)
        .map(str::to_string)
        .context("the device did not say which tile it started")
}

/// Interrupt the turn of the agent of `tile` in `workspace`: whether it was (not when it was
/// neither working nor waiting).
pub async fn interrupt(connection: &Connection, workspace: &str, tile: &str) -> Result<bool> {
    let mut w = Workspace::open(connection, workspace).await?;
    let answer = w.call("agent.interrupt", json!([tile])).await?;
    Ok(answer.get("interrupted").and_then(Value::as_bool) == Some(true))
}

/// Close the agent of `tile` in `workspace`: whether a workspace there had it.
pub async fn close(connection: &Connection, workspace: &str, tile: &str) -> Result<bool> {
    let mut w = Workspace::open(connection, workspace).await?;
    let answer = w.call("agent.close", json!([tile])).await?;
    Ok(answer.get("closed").and_then(Value::as_bool) == Some(true))
}

/// What the agent of `tile` in `workspace` changed.
pub async fn diff(connection: &Connection, workspace: &str, tile: &str) -> Result<Changes> {
    let mut w = Workspace::open(connection, workspace).await?;
    let answer = w.call("agent.diff", json!([tile])).await?;
    serde_json::from_value(answer).context("the device said what changed in a way not understood")
}
