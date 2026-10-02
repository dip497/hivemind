//! hive-net: hivemind's network (docs/design/multiplayer-2026-09-28.md, R10, R13). An iroh
//! endpoint that is this machine's device (R3), reached on the local network or through relays and
//! found through a lookup server, and the server roles anyone can run for their own devices
//! (§13.4).

pub mod access;
pub mod daemon;
pub mod doctor;
pub mod egress;
pub mod frames;
pub mod gate;
pub mod host_record;
mod jwt;
pub mod key;
pub mod limit;
pub mod lookup;
pub mod net;
pub mod pair;
pub mod ping;
pub mod profile;
pub mod push;
pub mod serve;
pub mod signed;
mod state_file;
pub mod ws;
