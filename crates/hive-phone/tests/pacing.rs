//! Published at a pace (pacing.rs; docs/design/phone-app-2026-10-02.md §3.4): what comes last is
//! published too, once those that send it are gone, so a conversation's end or a watch's last frame
//! is never lost for coming within 16 ms of what came before.

use std::{
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use hive_phone::pacing::{self, Paced};

/// What was taken since it last published; and each publishing, as it was.
struct Gathered {
    taken: Vec<u32>,
    published: Arc<Mutex<Vec<Vec<u32>>>>,
}

impl Paced for Gathered {
    type Input = u32;

    fn take(&mut self, n: u32) {
        self.taken.push(n);
    }

    fn publish(&mut self) {
        let taken = std::mem::take(&mut self.taken);
        self.published.lock().unwrap().push(taken);
    }
}

#[test]
fn what_comes_last_is_published_once_those_that_send_it_are_gone() {
    let published = Arc::new(Mutex::new(vec![]));
    let gathered = Gathered {
        taken: vec![],
        published: published.clone(),
    };
    let send = pacing::spawn("paced", gathered);
    // The first at once; the second within 16 ms of it, held back until they are gone.
    send.send(1).unwrap();
    send.send(2).unwrap();
    drop(send);
    thread::sleep(Duration::from_millis(200));
    assert_eq!(published.lock().unwrap().concat(), [1, 2]);
}
