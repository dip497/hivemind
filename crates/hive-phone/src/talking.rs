//! What an agent and the person say to each other, followed from the phone (spec/agents.md
//! "Conversation"; docs/design/phone-app-2026-10-02.md §5.4): told oldest first, each piece once,
//! at most every 16 ms; followed on across the background, the foreground and the device's
//! reconnects from as far as it was told into the agent's session, so the app only adds to what it
//! shows, but when the agent begins another session (`/clear`): that one is told anew.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use tokio::task::JoinHandle;

use crate::{
    connections::Connections,
    conversation::{self, Entry, Piece},
    failure::Lost,
    pacing::{self, Paced},
};

/// What a conversation followed tells as it goes, from a thread of its own.
pub trait Listener: Send + Sync {
    /// What was said since it last told, oldest first. `anew`: in place of all it told before, as
    /// the first telling is, and each after the agent began another session; then it may tell
    /// nothing yet.
    fn said(&self, entries: Vec<Entry>, anew: bool);
    /// It is told no more, and why: the device refused it, its workspace is not on that device
    /// now, or the device is no longer one of the person's. Told once, last.
    fn ended(&self, why: String);
}

/// What the telling thread is handed: what was said, anew or not; or why it ended.
enum Told {
    Said(Vec<Entry>, bool),
    Ended(String),
}

/// What is told, gathered between two tellings: what each session said, in order, and why it
/// ended.
struct Telling {
    listener: Arc<dyn Listener>,
    said: Vec<(Vec<Entry>, bool)>,
    ended: Option<String>,
    stopped: Arc<AtomicBool>,
}

impl Paced for Telling {
    type Input = Told;

    fn take(&mut self, told: Told) {
        match told {
            Told::Said(entries, anew) => match self.said.last_mut() {
                Some((gathered, _)) if !anew => gathered.extend(entries),
                _ => self.said.push((entries, anew)),
            },
            Told::Ended(why) => self.ended = Some(why),
        }
    }

    fn publish(&mut self) {
        let said = std::mem::take(&mut self.said);
        let ended = self.ended.take();
        if self.stopped.load(Ordering::Acquire) {
            return;
        }
        for (entries, anew) in said {
            self.listener.said(entries, anew);
        }
        if let Some(why) = ended {
            self.listener.ended(why);
        }
    }
}

/// A conversation followed until stopped, or dropped.
pub struct Talking {
    following: JoinHandle<()>,
    stopped: Arc<AtomicBool>,
}

impl Talking {
    /// Follow what the agent of `tile` in `workspace` on `device` and the person say to each other,
    /// from the last of it the device sends. Called in the runtime the connections run on.
    pub fn start(
        connections: &Connections,
        device: &str,
        workspace: &str,
        tile: &str,
        listener: Arc<dyn Listener>,
    ) -> Self {
        let stopped = Arc::new(AtomicBool::new(false));
        let telling = Telling {
            listener,
            said: vec![],
            ended: None,
            stopped: stopped.clone(),
        };
        let told = pacing::spawn("hive-phone conversation", telling);
        let connections = connections.clone();
        let (device, workspace, tile) =
            (device.to_string(), workspace.to_string(), tile.to_string());
        let following = tokio::spawn(async move {
            // The agent's session it was told of last, and how far into it.
            let mut from: Option<(String, u64)> = None;
            let why = loop {
                let connection = match connections.kept_for(&device, &workspace).await {
                    Ok(connection) => connection,
                    Err(lost) => break lost,
                };
                let last = from.clone();
                let resume = last.as_ref().map(|(session, at)| (session.as_str(), *at));
                let said = |piece: Piece| {
                    let anew = from.as_ref().is_none_or(|(told, _)| *told != piece.session);
                    if anew || !piece.entries.is_empty() {
                        let _ = told.send(Told::Said(piece.entries, anew));
                    }
                    from = Some((piece.session, piece.cursor));
                };
                let followed = conversation::follow(&connection, &workspace, &tile, resume, said);
                if let Some(lost) = followed.await.err().as_ref().and_then(Lost::refusal) {
                    break lost;
                }
                Connections::again(&connection).await;
            };
            let _ = told.send(Told::Ended(why.to_string()));
        });
        Self { following, stopped }
    }

    /// Follow it no more: nothing is told after.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.following.abort();
    }
}

impl Drop for Talking {
    fn drop(&mut self) {
        self.stop();
    }
}
