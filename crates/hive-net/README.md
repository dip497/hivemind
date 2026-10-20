# hive-net

Hivemind's network: this machine's device on it, and the servers (relay, lookup, access, push) you
run so your devices, guests and phone reach each other from different networks. It uses no server
you did not name.

How to run your own server: https://hivemind.griiken.com/guide/self-hosting/. Every option, port
and file to back up: https://hivemind.griiken.com/guide/hive-net/. The release installer puts
`hive-net` beside `hive`; `infra/` has a Docker stack.

```bash
hive-net serve --all --domain net.example.com --data /var/lib/hive-net   # every role, one port
hive-net id                                  # this device's id
hive-net ping <id>                           # from another machine
hive-net doctor                              # whether the network's servers answer, as JSON
```

The rest are on the reference page, and every option in the comment at the top of `src/main.rs`.

## Contributing

The design is `docs/design/multiplayer-2026-09-28.md` (R10, R13, R16). The contracts it follows:
[`spec/network-profile.md`](../../spec/network-profile.md),
[`spec/network-access.md`](../../spec/network-access.md) and [`spec/push.md`](../../spec/push.md).

The server roles and the `hive-net` command are behind the `server` feature, on by default. A crate
that is only ever a device, as the phone's is, depends on hive-net with `default-features = false`.

```bash
cargo test --locked   # the CLI end to end, profiles against conformance/network-profile.json,
                      # the key's id against conformance/identity.json, and the app's daemon
```
