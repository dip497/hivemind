//! hive-net: hivemind's network (docs/design/multiplayer-2026-09-28.md, R10). An iroh endpoint
//! that is this machine's device (R3), reached on the local network or through relays, and the
//! server roles anyone can run for their own devices (§13.4).

pub mod key;
pub mod net;
pub mod ping;
pub mod serve;
