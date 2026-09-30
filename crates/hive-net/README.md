# hive-net

hivemind's network (`docs/design/multiplayer-2026-09-28.md`, R10): an [iroh](https://www.iroh.computer)
endpoint that is this machine's device, and the server roles anyone can run for their own
devices. It never uses iroh's default presets, so it reaches no server you did not name.

```bash
hive-net id                                  # this device's id: the one Settings → Profile shows
hive-net run                                 # answer pings (local network: found by mDNS)
hive-net ping <id>                           # from another machine on the same network
hive-net serve --relay --bind 0.0.0.0:3340   # a relay, on a machine both can reach
hive-net run --relay http://<relay>:3340     # a device reached through it
hive-net ping <id> --relay http://<relay>:3340
```

The device key is the app's (`device.key` in `identity` in its data folder; `--identity <dir>`
names another). hive-net reads it and never makes one: the app makes it when it first starts.

## Network profiles

Which servers a device uses is its network profile (`spec/network-profile.md`, R16): `local`, the
default, uses none; `hosted` is hivemind's; any other is a file its network's admin signed.

```bash
hive-net profile sign profile.json --admin admin.key > network.json   # as the network's admin
hive-net profile link network.json          # hivemind://network/… for the people on it
hive-net profile verify <local|hosted|file|link>   # the profile, if it is one to use, as JSON
hive-net run --profile network.json         # reach and be reached through its relays
hive-net doctor --profile network.json      # which of its relays answer, as JSON
```

```bash
cargo test --locked        # the CLI end to end: the key's id against conformance/identity.json,
                           # the local network by mDNS, and through a relay it serves; profiles
                           # against conformance/network-profile.json; the app's daemon
```
