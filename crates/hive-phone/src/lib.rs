//! hive-phone: hivemind's phone, its core in Rust (docs/design/multiplayer-2026-09-28.md §9.3).
//! The iOS and Android apps link it; the `hive-phone` command does in a terminal what the phone
//! does, so it can be tried and tested without one. It runs no agents: it pairs with the person's
//! app, and is their device from then on (M5).

pub mod agents;
pub mod connections;
pub mod control;
pub mod conversation;
pub mod devices;
pub mod failure;
pub mod identity;
pub mod keys;
pub mod needs;
pub mod network;
pub mod pacing;
pub mod pairing;
pub mod person;
pub mod push;
pub mod screen;
pub mod talking;
pub mod watching;
pub mod workspace;

/// Now, in ms since the epoch: what the phone dates what it keeps by.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}
