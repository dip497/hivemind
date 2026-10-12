//! An agent's terminal, watched from the phone (docs/design/phone-app-2026-10-02.md §5.3): its
//! output and size go to a screen on a thread of its own, which publishes a frame at most every
//! 16 ms; who holds its keyboard is told as it changes; and what the person types goes in as them,
//! in the order they typed it, keys a moment apart. The watch goes on across the background, the
//! foreground and the device's reconnects, the screen sent again each time; it ends only with the
//! session.

use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::{sync::mpsc, task::JoinHandle};

use crate::{
    connections::Connections,
    failure::Lost,
    screen::{Frame, LiveScreen},
    workspace::{self, Input, Sent, Watched},
};

/// How a watch ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ended {
    /// The session ended, with its code.
    Exited(i64),
    /// There was no session to watch: it had ended before it was watched.
    NoSession,
    /// It is watched no more: the device refused it, holds its workspace no more, or is no longer
    /// one of the person's.
    Lost(Lost),
}

/// What a watch tells as it happens, from its own threads.
pub trait Watcher: Send + Sync {
    /// A frame was published: its revision.
    fn frame_ready(&self, revision: u64);
    /// Who holds its keyboard now, by name: none while the person's devices do.
    fn keyboard(&self, holder: Option<String>);
    /// How it ended. Told once, last: a connection that goes is no end.
    fn ended(&self, why: Ended);
}

/// An agent's terminal, watched until stopped, or dropped.
pub struct Watching {
    screen: Arc<LiveScreen>,
    typed: mpsc::UnboundedSender<Input>,
    /// The size the person fitted it to, sent again on each connection.
    fitted: Arc<Mutex<Option<(u16, u16)>>>,
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
        let fitted = Arc::new(Mutex::new(None));
        let fit = fitted.clone();
        // Everything the watch does is one task: stopped, all of it goes, its streams with it.
        let watching = tokio::spawn(async move {
            let mut again = false;
            let why = loop {
                let connection = match connections.kept_for(&device, &workspace).await {
                    Ok(connection) => connection,
                    Err(lost) => break Ended::Lost(lost),
                };
                // Each connection is sent the screen whole first: on the first, drawn as it comes;
                // on each after, drawn in place of what the last showed.
                let mut anew = std::mem::replace(&mut again, true);
                // What is typed while no connection takes it goes in on the next.
                let (keyed, written) = mpsc::channel(64);
                // A fit lasts as long as the connection it was sent on.
                if let Some(size) = *fit.lock().expect("a fit") {
                    let _ = keyed.try_send(Sent::Fit(Some(size)));
                }
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
                    never = workspace::pass_on(&mut typing, keyed) => match never {},
                };
                match watched {
                    Ok(Some(ended)) => break ended.code.map_or(Ended::NoSession, Ended::Exited),
                    Err(e) => match Lost::refusal(&e) {
                        Some(lost) => break Ended::Lost(lost),
                        None => Connections::again(&connection).await,
                    },
                    Ok(None) => Connections::again(&connection).await,
                }
            };
            watcher.ended(why);
        });
        Self {
            screen,
            typed,
            fitted,
            watching,
        }
    }

    /// The newest frame published.
    pub fn newest(&self) -> Arc<Frame> {
        self.screen.newest()
    }

    /// Type `text` as it is, as the person.
    pub fn type_text(&self, text: String) {
        let _ = self.typed.send(Input::Text(text));
    }

    /// Type `keys`, by name (`keys.rs`), as the person: each a moment after the last.
    pub fn type_keys(&self, keys: Vec<String>) {
        let _ = self.typed.send(Input::Keys(keys));
    }

    /// Size the terminal to `cols` × `rows` for this phone, until it is watched no more; none:
    /// back to the size it had.
    pub fn fit(&self, size: Option<(u16, u16)>) {
        *self.fitted.lock().expect("a fit") = size;
        let _ = self.typed.send(Input::Fit(size));
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
