//! An agent's terminal, as the apps draw it (docs/design/phone-app-2026-10-02.md §5.3): told only
//! a frame's revision, the app asks once a frame for the lines changed since the one it drew last.
//! It is watched across the background, the foreground and the device's reconnects until the
//! session ends.

use std::sync::Arc;

use hive_phone::{
    connections::Connections,
    failure::Lost,
    watching::{self, Watcher, Watching},
};

use crate::records::AgentRef;

/// What a watched terminal tells the app, from a thread of the core's: the app hops to its own.
#[uniffi::export(with_foreign)]
pub trait ScreenListener: Send + Sync {
    /// A frame is ready, at most one every 16 ms: its revision.
    fn frame_ready(&self, revision: u64);
    /// Who holds its keyboard, by name; none while the person's devices do.
    fn keyboard(&self, holder: Option<String>);
    /// How the watch ended. Told once, last: a connection that goes is no end, the watch goes on
    /// on the next one.
    fn ended(&self, why: ScreenEnded);
}

/// How a watched terminal ended, as the app tells the person.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum ScreenEnded {
    /// The session ended, with its exit code.
    Exited { code: i64 },
    /// There was no session to watch: it had ended before the watch began.
    NoSession,
    /// The device said no, in its words.
    Refused { why: String },
    /// Its workspace is not on that device now.
    NotHeld,
    /// That device is not one of the person's now.
    Unpaired,
}

impl From<watching::Ended> for ScreenEnded {
    fn from(ended: watching::Ended) -> Self {
        match ended {
            watching::Ended::Exited(code) => Self::Exited { code },
            watching::Ended::NoSession => Self::NoSession,
            watching::Ended::Lost(Lost::Refused(why)) => Self::Refused { why },
            watching::Ended::Lost(Lost::NotHeld(_)) => Self::NotHeld,
            watching::Ended::Lost(Lost::Unpaired(_)) => Self::Unpaired,
        }
    }
}

/// A listener, as the core tells a watch's news.
struct Listening(Arc<dyn ScreenListener>);

impl Watcher for Listening {
    fn frame_ready(&self, revision: u64) {
        self.0.frame_ready(revision)
    }

    fn keyboard(&self, holder: Option<String>) {
        self.0.keyboard(holder)
    }

    fn ended(&self, why: watching::Ended) {
        self.0.ended(why.into())
    }
}

/// An agent's terminal, watched until stopped.
#[derive(uniffi::Object)]
pub struct Watch(Watching);

impl Watch {
    /// Watch `agent`'s terminal from the phone `me`, its id. Called in the shared runtime.
    pub(crate) fn start(
        connections: &Connections,
        me: &str,
        agent: &AgentRef,
        listener: Arc<dyn ScreenListener>,
    ) -> Self {
        let listening = Arc::new(Listening(listener));
        let (device, workspace, tile) = (&agent.device, &agent.workspace, &agent.tile);
        Self(Watching::start(
            connections,
            me,
            device,
            workspace,
            tile,
            listening,
        ))
    }
}

#[uniffi::export]
impl Watch {
    /// What changed since `since`, the revision the app last drew: every line kept for 0.
    pub fn update(&self, since: u64) -> ScreenUpdate {
        let frame = self.0.newest();
        ScreenUpdate {
            revision: frame.revision,
            cols: frame.cols,
            rows: frame.rows,
            first_line: frame.first_line,
            line_count: frame.line_count(),
            cursor_line: frame.cursor_line,
            cursor_col: frame.cursor_col,
            cursor_visible: frame.cursor_visible,
            lines: frame
                .changed(since)
                .map(|(index, line)| ScreenLine {
                    index,
                    text: line.text.clone(),
                    runs: line.runs.clone(),
                })
                .collect(),
        }
    }

    /// Typed as it is, as the person.
    pub fn type_text(&self, text: String) {
        self.0.type_text(text)
    }

    /// Keys by name, as `hive ctl keys` takes them: enter, escape, tab, up, …, ctrl-c.
    pub fn type_keys(&self, keys: Vec<String>) {
        self.0.type_keys(keys)
    }

    pub fn stop(&self) {
        self.0.stop()
    }
}

/// What changed in a watched terminal since a revision the app drew.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ScreenUpdate {
    pub revision: u64,
    /// The session's size.
    pub cols: u16,
    pub rows: u16,
    /// The oldest line kept (2,000 lines of scrollback).
    pub first_line: u64,
    /// One past the newest line.
    pub line_count: u64,
    pub cursor_line: u64,
    pub cursor_col: u16,
    pub cursor_visible: bool,
    /// Changed since the revision asked about, oldest first: every line kept for 0, or a revision
    /// older than the core remembers.
    pub lines: Vec<ScreenLine>,
}

/// A line, numbered from when the watch began; its style runs packed 16 bytes each (§5.3).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ScreenLine {
    pub index: u64,
    pub text: String,
    pub runs: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn how_a_watch_ends_is_told_apart_as_the_app_shows_it() {
        let cases = [
            (watching::Ended::Exited(3), ScreenEnded::Exited { code: 3 }),
            (watching::Ended::NoSession, ScreenEnded::NoSession),
            (
                watching::Ended::Lost(Lost::Refused("not yours to watch".into())),
                ScreenEnded::Refused {
                    why: "not yours to watch".into(),
                },
            ),
            (
                watching::Ended::Lost(Lost::NotHeld("desk does not hold it".into())),
                ScreenEnded::NotHeld,
            ),
            (
                watching::Ended::Lost(Lost::Unpaired("d9 is not yours".into())),
                ScreenEnded::Unpaired,
            ),
        ];
        for (core, app) in cases {
            assert_eq!(ScreenEnded::from(core), app);
        }
    }
}
