//! hive-web: this browser as a device (docs/design/phone-browser-2026-10-03.md, B0). An iroh
//! endpoint with a key of its own that reaches a host through one relay (a browser sends no UDP),
//! end-to-end encrypted, on `hive/ws/1`'s named streams, as the native phone does. JS sees
//! `Device.start(relay)` → `dial(host)` → `open(name)` → `send(frame)` / `recv()`.

#[cfg(all(target_family = "wasm", target_os = "unknown"))]
mod wasm;
