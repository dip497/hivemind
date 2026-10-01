# Pairing (0.1)

Two devices become one person's (R14 and §5.2 in `docs/design/multiplayer-2026-09-28.md`): the
device being added receives the person key and certifies itself with it (`identity.md`), so it is
that person everywhere, and each device keeps the other in its list of the person's devices. It
runs over `hive/pair/1`, the one protocol a device answers for devices it does not know yet.

## The two sides

Each device is of a **kind**: `app` (the desktop app, someone's own computer) or `host` (`hive
host`, a machine that serves workspaces with nobody at it). The app **gives** the person it holds;
the host **takes** it. Its own person key, made when it first ran, owned nothing: it is set aside
(`person.key.<its id>.old`), not deleted. Two apps, or two hosts, do not pair yet.

Either side may show the code. The one that shows it is the **offering** device; the one that
enters it dials the other and is the **entering** device.

## The code

Six words from `pairing-words.json` (256 words, so 48 bits), made from random bytes by the offering
device, valid for five minutes and used once. Three wrong proofs void it. It is shown as:

- the words, in order, separated by spaces or hyphens: `amber-canal-drift-…`;
- a link, `hivemind://pair/<base64url of the JSON below>`, and a QR code of the link.

```json
{ "v": 1, "device": "<offering device's key hex>", "addrs": ["<ip:port>", …], "relay": "<url>" | null,
  "code": "<the six words, hyphen-separated>", "name": "<the offering device's name>", "kind": "app" | "host" }
```

**Finding the offering device from the words alone.** While a code is open, the offering device
announces a tag on the local network, in the user data of its mDNS record: `hive-pair=<tag>`,
where `tag` is the first 4 bytes, in lowercase hex, of `SHA-256("hive/pair-tag/1\n" ‖ code)`, and
`code` is the six words joined by `-`. The entering device looks for that tag among the devices
nearby. A tag no device announces is "not found on this network"; one that two devices announce
is refused. From elsewhere, only the link finds a device.

## The exchange

Each step is one `pair` request and its answer (`hello` → `reply`), on a connection whose ends are
the two devices' keys. A proof is

```
proof(label) = hex(HMAC-SHA256(key = code, message = "hive/pair/1 " ‖ label ‖ "\n" ‖ offering ‖ entering))
```

with `code` as UTF-8, and `offering` and `entering` the devices' keys in lowercase hex, so a proof
is good only between those two devices.

1. **Prove.** The entering device sends

   ```json
   { "v": 1, "pair": "prove", "proof": "<proof(\"entering\")>", "name": "<its name>", "kind": "app" | "host",
     "certificate": { … its device certificate … }, "addrs": ["<ip:port>", …], "relay": "<url>" | null }
   ```

   The offering device checks that a code is open, that the proof is right (compared in constant
   time; a wrong one counts against the code), that the certificate verifies and names the device
   that connected, and that one of the two is a host and the other an app. It answers

   ```json
   { "ok": true, "proof": "<proof(\"offering\")>", "name": "<its name>", "kind": "app" | "host", "certificate": { … },
     "addrs": [ … ], "relay": … }
   ```

   and, when it is the giver, also `"person": "<the person seed, hex>"`. The entering device checks
   that proof, and that the person given is the one that signed the giver's certificate, before it
   uses anything in the answer. From here each knows the other holds the code.
2. **Give** (only when the entering device is the giver). It sends
   `{ "v": 1, "pair": "give", "proof": "<proof(\"give\")>", "person": "<the person seed, hex>" }`,
   and the offering device, which proved itself in step 1, checks the proof and that the person is
   the one that signed the certificate the giver showed, and answers `{ "ok": true }`.

A failure answers `{ "ok": false, "error": "expired" | "wrong-code" | "malformed" | "not-this-device" | "same-kind" }`.
A host that already owns a workspace someone else was let into does not offer or enter a code:
taking another person would make that workspace no longer its owner's.

## After

- The taker keeps the person key it was given and certifies its own device with it. The giver
  certifies the taker's device with the same key, so each holds a certificate for the other that
  names the person.
- Each keeps the other in its list of the person's devices, `devices.json` next to its keys: its
  key, name, kind, where it says it is reached (`addrs`, `relay`), when it was paired, and that
  certificate.
- The person's devices are the owner of every workspace the person owns, wherever it is hosted:
  a host admits them, and tells them which workspaces it holds. Relays still admit by enrolment
  (`network-access.md`).
