//! hive-web: this browser as one of the person's devices (docs/design/phone-browser-2026-10-03.md).
//! The phone's own core (hive-phone) compiled to wasm: it pairs with the person's computer as the
//! phone does, and reaches it through a relay (a browser sends no UDP), end-to-end encrypted, on
//! `hive/ws/1`'s named streams. JS sees `pair(seed, link, name)`, `Device.start(seed, relays)` →
//! `reach(id, relay)` → a `Host`: `follow(listed)`, `answer`, `send`, `stop`, `closeAgent`,
//! `startable`, `start`, `conversation`, and `open(name)` → `send` / `recv`. The phone app in
//! `www/` (its TypeScript in `www/app`) keeps the device key and what pairing gave.

#[cfg(all(target_family = "wasm", target_os = "unknown"))]
mod wasm;
