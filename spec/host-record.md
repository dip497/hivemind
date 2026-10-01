# Host record (0.1)

Which device hosts a workspace now (§5.8 in `docs/design/multiplayer-2026-09-28.md`, R13), so a
guest or another of the owner's devices finds the host by the workspace alone. It is kept at the
network's lookup server (`spec/network-profile.md`, `lookup`); anyone may read it, and only the
workspace's owner can write it.

## The record

A [pkarr](https://pkarr.org) signed packet, signed by the **workspace key**
(`spec/identity.md`: derived from the owner's person key and the workspace's id, so any of the
owner's devices derives it and nobody else can), holding one TXT record:

```
_hive.<z-base-32 of the workspace's public key>.   TXT   "host=<device id>;seq=<n>"
```

- `host` is the hosting device's id, its public key in lowercase hex (its iroh `EndpointId`).
- `seq` counts the moves: the first host publishes 1, each move or take-over the one before plus
  one. Two devices taking over at once: the higher `seq` wins, a tie goes to the lower device id.
- A reader ignores parts of the text it does not know, and a packet with no `_hive` record or
  more than one is not a host record.

The packet is pkarr's: `<64-byte Ed25519 signature><8-byte big-endian timestamp in
microseconds><DNS packet>`, the signature over the timestamp and the DNS packet as pkarr says,
at most 1000 bytes of DNS packet.

## Where it is kept

`PUT <lookup>/<z-base-32 of the workspace's public key>` with the packet (without its leading
public key) as the body; `GET` the same path reads it (404: none). The lookup server keeps the
newest packet a key signed, refuses one the key in the path did not sign, and forgets a packet
not published again for seven days, so the host publishes again every hour and at every move.

**A reader checks the signature itself**, against the workspace's public key it already knows
(an invite carries it), and uses nothing a server says it did not sign.

## What it reveals

Which device hosts the workspace, which iroh treats as public anyway. Who may come in is still
the workspace's access list's to say.
