//! hive-phone: hivemind's phone, its core in Rust (docs/design/multiplayer-2026-09-28.md §9.3).
//! The iOS and Android apps link it; the `hive-phone` command does in a terminal what the phone
//! does, so it can be tried and tested without one. It runs no agents: it pairs with the person's
//! app, and is their device from then on (M5).

pub mod agents;
pub mod connect;
#[cfg(not(target_family = "wasm"))]
pub mod connections;
pub mod control;
pub mod conversation;
pub mod devices;
pub mod failure;
pub mod home;
pub mod homes;
pub mod identity;
pub mod keys;
pub mod layers;
pub mod mark;
pub mod markdown;
pub mod needs;
pub mod network;
pub mod browser_asks;
pub mod notes;
#[cfg(not(target_family = "wasm"))]
pub mod pacing;
pub mod pairing;
pub mod person;
#[cfg(not(target_family = "wasm"))]
pub mod push;
pub mod screen;
pub mod squeeze;
#[cfg(not(target_family = "wasm"))]
pub mod talking;
#[cfg(not(target_family = "wasm"))]
pub mod viewing;
pub mod views;
#[cfg(not(target_family = "wasm"))]
pub mod watching;
pub mod workspace;

/// Now, in ms since the epoch: what the phone dates what it keeps by.
pub fn now_ms() -> u64 {
    n0_future::time::SystemTime::now()
        .duration_since(n0_future::time::SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}
