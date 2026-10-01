# hive-phone

hivemind's phone, its core in Rust (`docs/design/multiplayer-2026-09-28.md` §9.3, M5): the library
the iOS and Android apps link, on [hive-net](../hive-net), and `hive-phone`, which does in a
terminal what the phone does, so it can be tried and tested without one. A phone runs no agents.

```bash
hive-phone id                         # this phone's id (its device key, made the first time)
hive-phone pair 'hivemind://pair/…'   # the link under Settings → Devices on your computer
hive-phone devices                    # the person's devices this phone paired with
hive-phone unpair <device>            # unpair from one (its id or name): each forgets the other
hive-phone needs                      # what waits on you on them, the one waiting longest first,
                                      # how many agents are at work, and of a device that is
                                      # away, what it last answered and when
hive-phone watch <workspace> <tile>   # an agent's terminal, read-only, until it ends (or Ctrl+C)
hive-phone answer <workspace> <tile> <since> --text 1   # answer what it waits on (or --approve,
                                      # --changes '<what>' for a plan); once, while it still waits
hive-phone push --listen 192.168.1.31:8080   # be told, at this address, when an agent begins
                                      # waiting on you, finishes or fails; each notice as it comes
```

Options: `--identity <dir>` (default: `hivemind-phone/identity` in this user's data folder),
`--name <name>` (what the app lists this phone as), `--json`.

A phone pairs with the app on one of your computers (`spec/pairing.md` 0.3): it scans the link,
proves it holds the code, and is given a certificate naming it as yours, signed by your person key.
It never holds that key, so a lost phone gives none away; unpair it on the computer, or unpair the
computer from the phone (`spec/pairing.md`, "Unpairing"). It pairs on the local network for now:
the link says where the app is. What each device last answered is kept beside its keys
(`heard.json`), to show while that device is away.

A phone is told what happens while you are away (`spec/push.md`): it gives each device it paired
with a Web Push subscription (an endpoint, and a P-256 push key and a secret of its own, kept as
`push.key` and `push.auth` beside its device key), and they post each notice there encrypted to it
(RFC 8291), so the push service, or anyone on the network, reads nothing of it. `push --listen` is
its own endpoint, on an address your computers reach it at; the apps give a push service's.

```bash
cargo test --locked   # conformance/pairing.json, needs.json and push.json (the phone's side), and what a phone keeps
```
