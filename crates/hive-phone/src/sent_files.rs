//! Files an agent sent the person's phone (spec/sent-files.md): their list, followed, and each file
//! fetched in pieces by its id. A fetch that stops part way goes on from where it stopped, on the
//! next connection, since the computer's copy never changes.

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use iroh::endpoint::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::workspace::{read_message, result_of, Workspace};

/// The largest file a phone takes: it holds it whole in memory until it is saved.
pub const FILE_MAX: u64 = 32 * 1024 * 1024;
const NAME_MAX: usize = 200;

/// A file an agent sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SentFile {
    pub id: String,
    pub name: String,
    pub size: u64,
    /// Its media type.
    #[serde(rename = "type")]
    pub mime: String,
    /// When it was sent, ms since the epoch.
    pub at: u64,
}

impl SentFile {
    /// Whether it is one a phone takes: an id it can ask for, a name with no folder, a size it holds.
    fn fits(&self) -> bool {
        self.id.len() == 32
            && self.id.bytes().all(|b| b.is_ascii_hexdigit())
            && !self.name.is_empty()
            && self.name.chars().count() <= NAME_MAX
            && !self.name.contains(['/', '\\'])
            && self.size <= FILE_MAX
    }
}

/// The files in what a device sent, leaving out any that is not one a phone takes.
pub fn read_files(files: &Value) -> Vec<SentFile> {
    files
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| serde_json::from_value::<SentFile>(f.clone()).ok())
        .filter(SentFile::fits)
        .collect()
}

/// Follow the files the agent of `tile` sent, through `workspace`: `listed` is called with the whole
/// list, first as it stands and then each time it changes, until the device closes the stream.
pub async fn follow(
    connection: &Connection,
    workspace: &str,
    tile: &str,
    mut listed: impl FnMut(Vec<SentFile>),
) -> Result<()> {
    let mut w = Workspace::open(connection, workspace).await?;
    let asked = w.ask("agent.files", json!([tile])).await?;
    loop {
        let Some(message) = read_message(&mut w.recv).await? else {
            return Ok(());
        };
        if message.get("id").and_then(Value::as_u64) == Some(asked) {
            listed(read_files(&result_of(message)?["files"]));
            continue;
        }
        let events = match message {
            Value::Array(events) => events,
            m => vec![m],
        };
        for e in events {
            if e.get("event").and_then(Value::as_str) != Some("agent.filesChanged") {
                continue;
            }
            if e["params"][0].as_str() == Some(tile) {
                listed(read_files(&e["params"][1]));
            }
        }
    }
}

/// Fetch the file `id` of `size` bytes from `from` on, through `workspace`, on a stream of its own:
/// `got` is handed each piece, in order. What is handed stays had if this fails.
pub async fn fetch(
    connection: &Connection,
    workspace: &str,
    id: &str,
    size: u64,
    from: u64,
    mut got: impl FnMut(Vec<u8>),
) -> Result<()> {
    if size > FILE_MAX {
        bail!("that file is larger than a phone takes");
    }
    if from >= size {
        return Ok(());
    }
    let mut w = Workspace::open(connection, workspace).await?;
    let mut at = from;
    while at < size {
        let answer = w.call("agent.filePiece", json!([id, at])).await?;
        if answer.get("size").and_then(Value::as_u64) != Some(size) {
            bail!("the device says that file is another size now");
        }
        let piece = STANDARD
            .decode(
                answer
                    .get("data")
                    .and_then(Value::as_str)
                    .context("the device sent no file")?,
            )
            .context("the device sent a file that is not base64")?;
        if piece.is_empty() {
            bail!("the device sent less of that file than it said it had");
        }
        at += piece.len() as u64;
        if at > size {
            bail!("the device sent more of that file than it said it had");
        }
        got(piece);
    }
    Ok(())
}
