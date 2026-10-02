//! A community view shown on the phone (docs/design/phone-app-2026-10-02.md §6.1, P8): its session
//! on the device that holds its workspace, on the connection kept to that device, relayed both
//! ways, with the screen it is shown on as that changes. A connection that goes ends the session
//! there: another is opened on the next connection, on the newest screen, and the view is told to
//! start again in it (its page loaded anew, so its handshake is the new session's). It ends when
//! the device's host disables the view, refuses it, holds its workspace no more, or is no longer
//! one of the person's.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use serde_json::Value;
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
};

use crate::{
    connections::Connections,
    failure::Lost,
    views::{self, Screen, Session},
};

/// How many messages the view may have posted that are not on their way yet: past them, it posts
/// faster than the device takes them, and what it posts more is dropped, as a host would count it
/// flooding anyway.
const POSTS_WAITING: usize = 256;

/// Why a view shown on the phone is told no more, or starts again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ended {
    /// The connection went, and the view has a session again on the next: it starts again in it,
    /// its page loaded anew. Not the last thing told.
    Restarting,
    /// The device's host disabled the view, and why: it flooded, or sent what it may not.
    Disabled(String),
    /// It is told no more: the device refused it, holds its workspace no more, or is no longer
    /// one of the person's.
    Lost(Lost),
}

/// What a view shown on the phone tells, from the core's thread.
pub trait Viewer: Send + Sync {
    /// Its host said `message` to the view, a view protocol message.
    fn said(&self, message: Value);
    /// It starts again in another session (`Restarting`), or is told no more: then told once,
    /// last.
    fn ended(&self, why: Ended);
}

/// A view shown on the phone, until stopped, or dropped.
pub struct Viewing {
    posts: mpsc::Sender<Value>,
    screen: watch::Sender<Screen>,
    stopped: Arc<AtomicBool>,
    viewing: JoinHandle<()>,
}

/// Who is told what the view's session says: nobody once it is stopped.
struct Telling {
    viewer: Arc<dyn Viewer>,
    stopped: Arc<AtomicBool>,
}

impl Telling {
    fn said(&self, message: Value) {
        if !self.stopped.load(Ordering::Acquire) {
            self.viewer.said(message)
        }
    }

    fn ended(&self, why: Ended) {
        if !self.stopped.load(Ordering::Acquire) {
            self.viewer.ended(why)
        }
    }
}

impl Viewing {
    /// Show the view `view` on `workspace`, on `device`, on `screen`. Called in the runtime the
    /// connections run on.
    pub fn start(
        connections: &Connections,
        device: &str,
        workspace: &str,
        view: &str,
        screen: Screen,
        viewer: Arc<dyn Viewer>,
    ) -> Self {
        let (posts, mut posted) = mpsc::channel(POSTS_WAITING);
        let (screen, mut shown) = watch::channel(screen);
        let stopped = Arc::new(AtomicBool::new(false));
        let telling = Telling {
            viewer,
            stopped: stopped.clone(),
        };
        let (connections, device) = (connections.clone(), device.to_string());
        let (workspace, view) = (workspace.to_string(), view.to_string());
        // Everything the view does is one task: stopped, all of it goes, its stream with it.
        let viewing = tokio::spawn(async move {
            let mut opened = false;
            let why = loop {
                let connection = match connections.kept_for(&device, &workspace).await {
                    Ok(connection) => connection,
                    Err(lost) => break Ended::Lost(lost),
                };
                let newest = shown.borrow_and_update().clone();
                let relayed = match Session::open(&connection, &workspace, &view, &newest).await {
                    Ok(session) => {
                        // Open again: the view starts again in this one, from its page.
                        let again = std::mem::replace(&mut opened, true);
                        if again {
                            telling.ended(Ended::Restarting);
                        }
                        let said = |message| telling.said(message);
                        session.relay(&mut posted, &mut shown, again, said).await
                    }
                    Err(e) => Err(e),
                };
                match relayed {
                    Ok(views::Ended::Host(why)) => break Ended::Disabled(why),
                    // Never closed from here: what it posts ends only with it.
                    Ok(views::Ended::Closed) => return,
                    Err(e) => match Lost::refusal(&e) {
                        Some(lost) => break Ended::Lost(lost),
                        None => Connections::again(&connection).await,
                    },
                }
            };
            telling.ended(why);
        });
        Self {
            posts,
            screen,
            stopped,
            viewing,
        }
    }

    /// Post `message`, which the view posted, to its host: dropped when it is not JSON, or while
    /// the view posts faster than its host takes it.
    pub fn post(&self, message: &str) {
        if let Ok(message) = serde_json::from_str(message) {
            let _ = self.posts.try_send(message);
        }
    }

    /// The view is shown on `screen` now: its host tells it what changed.
    pub fn screen(&self, screen: Screen) {
        self.screen.send_replace(screen);
    }

    /// Show it no more: nothing is told after, and the device lets go of its session.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.viewing.abort();
    }
}

impl Drop for Viewing {
    fn drop(&mut self) {
        self.stop();
    }
}
