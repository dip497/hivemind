//! What an agent asks the person on a Browser tile on the computer: to sign in with a saved sign-in,
//! or to do something in the page themselves. The phone lists them and says the person's answer.
//! They are the person's alone: the computer answers only their own devices.

use anyhow::Result;
use iroh::endpoint::Connection;
use serde_json::{json, Value};

use crate::workspace::Workspace;

/// The questions waiting on the person, as the computer lists them (`browser.asks`).
pub async fn asks(connection: &Connection, workspace: &str) -> Result<Value> {
    let mut w = Workspace::open(connection, workspace).await?;
    let listed = w.call("browser.asks", json!([])).await?;
    Ok(listed.get("asks").cloned().unwrap_or_else(|| json!([])))
}

/// Say `answer` (`yes`, `always`, `no` or `done`) to question `ask`. Whether it was still waiting.
pub async fn answer(
    connection: &Connection,
    workspace: &str,
    ask: u64,
    answer: &str,
) -> Result<bool> {
    let mut w = Workspace::open(connection, workspace).await?;
    let said = w.call("browser.answer", json!([ask, answer])).await?;
    Ok(said.get("answered").and_then(Value::as_bool) == Some(true))
}
