//! A screen on a thread of its own (docs/design/phone-app-2026-10-02.md §3.5), as the phone apps
//! watch a terminal; the phone page paces its own frames (crates/hive-web).

use std::{
    sync::{mpsc::Sender, Arc, Mutex},
    time::Instant,
};

use super::{Frame, Screen, RESET};
use crate::pacing::{self, Paced};

/// A screen on a thread of its own (§3.5): fed the session's output and size as they come, a frame
/// published at most every 16 ms, and never half a synchronized update.
pub struct LiveScreen {
    fed: Sender<Fed>,
    newest: Arc<Mutex<Arc<Frame>>>,
}

/// What a live screen is fed.
enum Fed {
    Output(Vec<u8>),
    Size(u16, u16),
}

/// The screen as its thread keeps it.
struct Painting<F> {
    screen: Screen,
    newest: Arc<Mutex<Arc<Frame>>>,
    drawn: F,
}

impl<F: Fn(u64)> Paced for Painting<F> {
    type Input = Fed;

    fn take(&mut self, fed: Fed) {
        match fed {
            Fed::Output(bytes) => self.screen.feed(&bytes),
            Fed::Size(cols, rows) => self.screen.resize(cols, rows),
        }
    }

    fn held(&self) -> Option<Instant> {
        self.screen.held()
    }

    fn publish(&mut self) {
        if let Some(frame) = self.screen.frame() {
            let revision = frame.revision;
            *self.newest.lock().expect("a frame") = Arc::new(frame);
            (self.drawn)(revision);
        }
    }
}

impl LiveScreen {
    /// A blank screen at the size a watch starts at; `drawn` is told each frame's revision, on the
    /// screen's thread, as the frame is published. The thread ends with the live screen.
    pub fn start(drawn: impl Fn(u64) + Send + 'static) -> Self {
        let mut screen = Screen::default();
        let newest = Arc::new(Mutex::new(Arc::new(
            screen.frame().expect("a new screen's first frame"),
        )));
        let painting = Painting {
            screen,
            newest: newest.clone(),
            drawn,
        };
        Self {
            fed: pacing::spawn("hive-phone screen", painting),
            newest,
        }
    }

    /// More of the session's output.
    pub fn output(&self, bytes: &[u8]) {
        let _ = self.fed.send(Fed::Output(bytes.to_vec()));
    }

    /// The session's screen sent again whole, as it is sent on each connection that shows it:
    /// drawn in place of what was shown, from a reset, as the desktop draws a session it attaches
    /// to again.
    pub fn redraw(&self, bytes: &[u8]) {
        let _ = self.fed.send(Fed::Output([RESET, bytes].concat()));
    }

    /// The size the session took.
    pub fn size(&self, cols: u16, rows: u16) {
        let _ = self.fed.send(Fed::Size(cols, rows));
    }

    /// The newest frame published.
    pub fn newest(&self) -> Arc<Frame> {
        self.newest.lock().expect("a frame").clone()
    }
}
