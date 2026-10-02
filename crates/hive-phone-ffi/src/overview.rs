//! The overview the apps draw (docs/design/phone-app-2026-10-02.md §5.2), made again as what the
//! phone knows of the person's devices changes, at most every 16 ms (§3.4): its followers are
//! told only its revision, and pull it once on their main thread however many came meanwhile.

use std::sync::{
    atomic::{AtomicU64, Ordering},
    mpsc::Sender,
    Arc, Mutex, PoisonError,
};

use hive_phone::{
    connections::Connections,
    identity::Identity,
    pacing::{self, Paced},
};

use crate::records::{self, Overview};

/// Told, from a thread of the core's, that the overview changed: the app hops to its own.
#[uniffi::export(with_foreign)]
pub trait OverviewListener: Send + Sync {
    fn changed(&self, revision: u64);
}

/// Those following the overview, each by the number it was given.
type Followers = Arc<Mutex<Vec<(u64, Arc<dyn OverviewListener>)>>>;

/// The overview, made anew as it changes, and those following it.
pub(crate) struct Overviews {
    newest: Arc<Mutex<Arc<Overview>>>,
    followers: Followers,
    numbered: AtomicU64,
    changes: Sender<()>,
}

/// The overview as its thread makes it.
struct Making {
    connections: Connections,
    identity: Arc<Identity>,
    revision: u64,
    newest: Arc<Mutex<Arc<Overview>>>,
    followers: Followers,
}

impl Paced for Making {
    type Input = ();

    fn take(&mut self, (): ()) {}

    fn publish(&mut self) {
        self.revision += 1;
        let seen = self.connections.seen();
        let made = records::overview(self.revision, &seen, self.identity.person());
        *lock(&self.newest) = Arc::new(made);
        let followers: Vec<_> = lock(&self.followers)
            .iter()
            .map(|(_, f)| f.clone())
            .collect();
        for follower in followers {
            follower.changed(self.revision);
        }
    }
}

impl Overviews {
    /// The overview of what `connections` know, as the phone `identity` kept it first: made again
    /// each time it is told what is known changed.
    pub(crate) fn start(connections: Connections, identity: Arc<Identity>) -> Self {
        let first = records::overview(0, &connections.seen(), identity.person());
        let newest = Arc::new(Mutex::new(Arc::new(first)));
        let followers = Followers::default();
        let making = Making {
            connections,
            identity,
            revision: 0,
            newest: newest.clone(),
            followers: followers.clone(),
        };
        Self {
            newest,
            followers,
            numbered: AtomicU64::new(0),
            changes: pacing::spawn("hive-phone overview", making),
        }
    }

    /// Where to tell it that what is known changed.
    pub(crate) fn changes(&self) -> Sender<()> {
        self.changes.clone()
    }

    pub(crate) fn newest(&self) -> Arc<Overview> {
        lock(&self.newest).clone()
    }

    /// `listener` is told of each overview from now on, until it stops.
    pub(crate) fn follow(&self, listener: Arc<dyn OverviewListener>) -> Following {
        let number = self.numbered.fetch_add(1, Ordering::Relaxed);
        lock(&self.followers).push((number, listener));
        Following {
            number,
            followers: self.followers.clone(),
        }
    }
}

/// A listener following the overview.
#[derive(uniffi::Object)]
pub struct Following {
    number: u64,
    followers: Followers,
}

#[uniffi::export]
impl Following {
    /// It is told of no more.
    pub fn stop(&self) {
        lock(&self.followers).retain(|(number, _)| *number != self.number);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use std::{
        thread,
        time::{Duration, Instant},
    };

    use super::*;

    /// When each overview was told, and its revision.
    #[derive(Default)]
    struct Told(Mutex<Vec<(Instant, u64)>>);

    impl OverviewListener for Told {
        fn changed(&self, revision: u64) {
            lock(&self.0).push((Instant::now(), revision));
        }
    }

    #[test]
    fn a_burst_of_changes_is_told_at_most_every_16_ms_the_newest_last_and_never_after_stopping() {
        let dir = std::env::temp_dir().join(format!("hive-phone-ffi-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let identity = Arc::new(Identity::open(&dir).unwrap());
        let overviews = Overviews::start(Connections::new(identity.clone(), || {}), identity);
        let told = Arc::new(Told::default());
        let following = overviews.follow(told.clone());
        let changes = overviews.changes();
        let began = Instant::now();
        for _ in 0..500 {
            changes.send(()).unwrap();
            thread::sleep(Duration::from_micros(100));
        }
        thread::sleep(Duration::from_millis(100));
        let seen = lock(&told.0).clone();
        let took = seen.last().unwrap().0 - began;
        assert!(seen.len() >= 2);
        assert!(
            seen.len() as u128 <= took.as_millis() / 16 + 2,
            "{} told in {took:?}",
            seen.len()
        );
        for pair in seen.windows(2) {
            assert!(pair[1].0 - pair[0].0 >= Duration::from_millis(15));
            assert!(pair[1].1 > pair[0].1);
        }
        assert_eq!(seen.last().unwrap().1, overviews.newest().revision);
        following.stop();
        changes.send(()).unwrap();
        thread::sleep(Duration::from_millis(60));
        assert_eq!(lock(&told.0).len(), seen.len());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
