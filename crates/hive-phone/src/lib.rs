//! hive-phone: hivemind's phone, its core in Rust (docs/design/multiplayer-2026-09-28.md §9.3).
//! The iOS and Android apps link it; the `hive-phone` command does in a terminal what the phone
//! does, so it can be tried and tested without one. It runs no agents: it pairs with the person's
//! app, and is their device from then on (M5).

pub mod devices;
pub mod identity;
pub mod needs;
pub mod pairing;
pub mod workspace;
