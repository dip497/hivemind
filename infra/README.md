# infra

What a hivemind network's servers are, to run them yourself (R13 in
`docs/design/multiplayer-2026-09-28.md`): one `hive-net serve --all` serving a relay, a lookup
server, the access role and the push server on one port (phones told at a distributor in the
building too with `HIVE_PUSH_ALLOW=<its network>`). The guide is `docs/src/content/docs/guide/self-hosting.md`
(on the docs site: *Self-hosting*).

| File | What |
|---|---|
| `Dockerfile` | hive-net built from this repository, on a distroless base |
| `compose.yml` | the stack, plain HTTP on 3340: a network inside a building, or to try it |
| `compose.public.yml` | over it, a server with a public name: HTTPS on 443 from Let's Encrypt |
| `check.sh` | R13's checks against the running stack; CI runs them on every change |

```bash
HIVE_URL=http://192.168.1.10:3340 docker compose -f infra/compose.yml up -d
docker compose -f infra/compose.yml logs hive-net        # the network's link
bash infra/check.sh                                       # the checks (HIVE_URL as above)
```

hivemind's own network (the *Hosted* profile) runs the same binary: three relays, one per
region, each `hive-net serve --relay --access-url …` under systemd, a lookup server, the
access service, and the push server with hivemind's Apple and Google credentials. Deploying it
waits on its cloud accounts.
