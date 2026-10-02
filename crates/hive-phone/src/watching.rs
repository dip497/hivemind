//! An agent's terminal, watched from the phone (docs/design/phone-app-2026-10-02.md §5.3): its
//! output and size go to a screen on a thread of its own, which publishes a frame at most every
//! 16 ms; who holds its keyboard is told as it changes; and what the person types goes in as them,
//! in the order they typed it, keys a moment apart. The watch goes on across the background, the
//! foreground and the device's reconnects, the screen sent again each time; it ends only with the
//! session.

use std::{convert::Infallible, sync::Arc};

use serde_json::Value;
use tokio::{sync::mpsc, task::JoinHandle};

use crate::{
    connections::Connections,
    failure::Failure,
    keys,
    screen::{Frame, LiveScreen},
    workspace::{self, Watched},
};

/// What a watch tells as it happens, from its own threads.
pub trait Watcher: Send + Sync {
    /// A frame was published: its revision.
    fn frame_ready(&self, revision: u64);
    /// Who holds its keyboard now, by name: none while the person's devices do.
    fn keyboard(&self, holder: Option<String>);
    /// The session ended, with its code; or there is none to watch now (none): it ended unseen,
    /// its workspace is not on that device now, or the device refused it. Told once, last.
    fn ended(&self, code: Option<i64>);
}

/// What the person types: text as it is, or keys by name.
enum Typed {
    Text(String),
    Keys(Vec<String>),
}

/// An agent's terminal, watched until stopped, or dropped.
pub struct Watching {
    screen: Arc<LiveScreen>,
    typed: mpsc::UnboundedSender<Typed>,
    watching: JoinHandle<()>,
}

impl Watching {
    /// Watch the terminal of `tile` in `workspace` on `device`, the phone `me` (its id) watching:
    /// a blank screen until the device sends it. Called in the runtime the connections run on.
    pub fn start(
        connections: &Connections,
        me: &str,
        device: &str,
        workspace: &str,
        tile: &str,
        watcher: Arc<dyn Watcher>,
    ) -> Self {
        let told = watcher.clone();
        let screen = Arc::new(LiveScreen::start(move |revision| {
            told.frame_ready(revision)
        }));
        let (typed, mut typing) = mpsc::unbounded_channel();
        let (connections, me, device) = (
            connections.clone(),
            format!("peer:{me}"),
            device.to_string(),
        );
        let (workspace, tile, fed) = (workspace.to_string(), tile.to_string(), screen.clone());
        // Everything the watch does is one task: stopped, all of it goes, its streams with it.
        let watching = tokio::spawn(async move {
            let mut again = false;
            let code = loop {
                let Ok(connection) = connections.kept_for(&device, &workspace).await else {
                    break None;
                };
                // Each connection is sent the screen whole first: on the first, drawn as it comes;
                // on each after, drawn in place of what the last showed.
                let mut anew = std::mem::replace(&mut again, true);
                // What is typed while no connection takes it goes in on the next.
                let (keyed, written) = mpsc::channel(64);
                let watched =
                    workspace::watch(&connection, &workspace, &tile, Some(written), |w| match w {
                        Watched::Output(data) if std::mem::take(&mut anew) => {
                            fed.redraw(data.as_bytes())
                        }
                        Watched::Output(data) => fed.output(data.as_bytes()),
                        Watched::Size(cols, rows) => fed.size(cols, rows),
                        Watched::Keyboard(holder) => watcher.keyboard(holder_of(holder, &me)),
                    });
                let watched = tokio::select! {
                    watched = watched => watched,
                    never = type_in(&mut typing, keyed) => match never {},
                };
                match watched {
                    Ok(Some(ended)) => break ended.code,
                    Err(e) if Failure::refused(&e) => break None,
                    _ => Connections::again(&connection).await,
                }
            };
            watcher.ended(code);
        });
        Self {
            screen,
            typed,
            watching,
        }
    }

    /// The newest frame published.
    pub fn newest(&self) -> Arc<Frame> {
        self.screen.newest()
    }

    /// Type `text` as it is, as the person.
    pub fn type_text(&self, text: String) {
        let _ = self.typed.send(Typed::Text(text));
    }

    /// Type `keys`, by name (`keys.rs`), as the person: each a moment after the last.
    pub fn type_keys(&self, keys: Vec<String>) {
        let _ = self.typed.send(Typed::Keys(keys));
    }

    /// Watch no more: the device lets go of the terminal for this phone.
    pub fn stop(&self) {
        self.watching.abort();
    }
}

impl Drop for Watching {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Who holds a keyboard, as the person is told: none while their devices type into it, this phone
/// among them; else by name.
fn holder_of(holder: Option<&Value>, me: &str) -> Option<String> {
    let holder = holder.filter(|h| h["id"] != me)?;
    let name = holder["name"].as_str().filter(|n| !n.is_empty());
    Some(name.unwrap_or("someone").to_string())
}

/// What the person types, in order, for as long as a connection takes it: text as it is, keys as
/// their bytes a moment apart.
async fn type_in(
    typed: &mut mpsc::UnboundedReceiver<Typed>,
    written: mpsc::Sender<String>,
) -> Infallible {
    while let Some(typed) = typed.recv().await {
        let writes = match typed {
            Typed::Text(text) => vec![text],
            Typed::Keys(keys) => keys.iter().map(|k| keys::bytes(k).to_string()).collect(),
        };
        for (i, write) in writes.into_iter().enumerate() {
            if i > 0 {
                tokio::time::sleep(keys::GAP).await;
            }
            let _ = written.send(write).await;
        }
    }
    std::future::pending().await
}
