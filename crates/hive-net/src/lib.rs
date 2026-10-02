//! hive-net: hivemind's network (docs/design/multiplayer-2026-09-28.md, R10, R13). An iroh
//! endpoint that is this machine's device (R3), reached on the local network or through relays and
//! found through a lookup server, and the server roles anyone can run for their own devices
//! (§13.4): the relay (`serve`), lookup, access and push roles, behind the `server` feature, so
//! that a phone, which runs none of them, links none of them.

pub mod access;
pub mod daemon;
pub mod doctor;
pub mod egress;
pub mod frames;
pub mod gate;
pub mod host_record;
pub mod key;
pub mod net;
pub mod pair;
pub mod ping;
pub mod profile;
pub mod push;
pub mod signed;
pub mod ws;

#[cfg(feature = "server")]
mod jwt;
#[cfg(feature = "server")]
pub mod limit;
#[cfg(feature = "server")]
pub mod lookup;
#[cfg(feature = "server")]
pub mod serve;
#[cfg(feature = "server")]
mod state_file;
