# alacritty_terminal, for the phone page

[alacritty_terminal](https://crates.io/crates/alacritty_terminal) 0.26.0 (Apache-2.0,
`LICENSE-APACHE`), the VT emulator hive-phone's screen runs (`crates/hive-phone/src/screen.rs`).
The phone page builds that screen to wasm (`crates/hive-web`), and the crate does not build there:
its pty and event loop need `polling` and `home`, which have no wasm. Patched in for hive-web's
workspace alone (`crates/Cargo.toml`); the phone apps build the crate from crates.io.

The one change from upstream, in `src/lib.rs`: `event_loop` and `tty` are left out on wasm, and
what only they use (`home`, `libc`, `polling`) is a dependency elsewhere only. Taking a newer
release: copy its `src` here and make the same change.
