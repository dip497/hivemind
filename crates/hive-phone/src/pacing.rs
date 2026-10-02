//! Published at most every 16 ms, the newest kept (docs/design/phone-app-2026-10-02.md §3.4): a
//! burst of changes is folded into one snapshot, and the app told only its revision, so it pulls
//! the snapshot once on its main thread however many came meanwhile.

use std::{
    sync::mpsc::{self, Receiver, RecvTimeoutError, Sender},
    thread,
    time::{Duration, Instant},
};

/// The least time between two snapshots.
pub const EVERY: Duration = Duration::from_millis(16);

/// What is published at a pace: its inputs taken as they come, a snapshot made of what was taken.
pub trait Paced {
    type Input: Send + 'static;
    /// Take one input.
    fn take(&mut self, input: Self::Input);
    /// While something holds the next snapshot back: until when.
    fn held(&self) -> Option<Instant> {
        None
    }
    /// Make the snapshot of what was taken, and tell of it.
    fn publish(&mut self);
}

/// Run `paced` on a thread of its own, called `name`, until every sender of its inputs is gone:
/// each is taken as it comes, and a snapshot made at once after a quiet spell, else 16 ms after
/// the last one, of all that came meanwhile.
pub fn spawn<P: Paced + Send + 'static>(name: &str, mut paced: P) -> Sender<P::Input> {
    let (send, inputs) = mpsc::channel();
    thread::Builder::new()
        .name(name.into())
        .spawn(move || run(&mut paced, &inputs))
        .expect("a thread for its own");
    send
}

fn run<P: Paced>(paced: &mut P, inputs: &Receiver<P::Input>) {
    let mut last: Option<Instant> = None;
    let mut pending = false;
    loop {
        let input = if pending {
            let next = last.map_or_else(Instant::now, |at| at + EVERY);
            let due = paced.held().map_or(next, |held| held.max(next));
            match inputs.recv_timeout(due.saturating_duration_since(Instant::now())) {
                Ok(input) => Some(input),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        } else {
            match inputs.recv() {
                Ok(input) => Some(input),
                Err(_) => return,
            }
        };
        if let Some(input) = input {
            paced.take(input);
            pending = true;
        }
        if pending && due(last, paced.held()) {
            paced.publish();
            (last, pending) = (Some(Instant::now()), false);
        }
    }
}

/// Whether a snapshot may go out now: 16 ms since the last, and nothing holding it back.
fn due(last: Option<Instant>, held: Option<Instant>) -> bool {
    let now = Instant::now();
    last.is_none_or(|at| now >= at + EVERY) && held.is_none_or(|held| now >= held)
}
