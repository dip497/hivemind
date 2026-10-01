# hive-phone

hivemind's phone, its core in Rust (`docs/design/multiplayer-2026-09-28.md` §9.3, M5): the library
the iOS and Android apps link, on [hive-net](../hive-net), and `hive-phone`, which does in a
terminal what the phone does, so it can be tried and tested without one. A phone runs no agents.

```bash
hive-phone id                         # this phone's id (its device key, made the first time)
hive-phone pair 'hivemind://pair/…'   # the link under Settings → Devices on your computer
hive-phone devices                    # the person's devices this phone paired with
hive-phone needs                      # what waits on you on them, the one waiting longest first
hive-phone watch <workspace> <tile>   # an agent's terminal, read-only, until it ends (or Ctrl+C)
```

Options: `--identity <dir>` (default: `hivemind-phone/identity` in this user's data folder),
`--name <name>` (what the app lists this phone as), `--json`.

A phone pairs with the app on one of your computers (`spec/pairing.md` 0.3): it scans the link,
proves it holds the code, and is given a certificate naming it as yours, signed by your person key.
It never holds that key, so a lost phone gives none away; unpair it on the computer. It pairs on
the local network for now: the link says where the app is.

```bash
cargo test --locked   # conformance/pairing.json and needs.json (the phone's side), and what a phone keeps
```
