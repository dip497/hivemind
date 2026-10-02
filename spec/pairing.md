# Pairing (0.6)

Two devices become one person's (R14 and §5.2 in `docs/design/multiplayer-2026-09-28.md`): the
device being added receives the person key and certifies itself with it (`identity.md`), or, a
phone, a certificate the other signs for it, so it is that person everywhere, and each device keeps
the other in its list of the person's devices. It
runs over `hive/pair/1`, the one protocol a device answers for devices it does not know yet.

## The two sides

Each device is of a **kind**: `app` (the desktop app, someone's own computer), `host` (`hive
host`, a machine that serves workspaces with nobody at it) or `phone` (0.3: the phone app, which
runs nothing and is given no person key). One device **gives** the person it holds and the other
**takes** it:

- an app and a host: the app gives, the host takes;
- two apps: the one entering the code is the device being added, and takes (§5.2);
- an app and a phone: the app gives, and the phone is always the one entering (it scans the
  app's link);
- two hosts, a host and a phone, and two phones do not pair: neither of them gives.

A phone takes a **certificate**, not the person key: the app certifies the phone's device with the
person key, and the phone keeps that certificate. It is the person's device, as the certificate
says, and holds nothing it could make another device the person's with; a lost phone gives away no
key. A phone never offers a code.

The taker's own person key is set aside (`person.key.<its id>.old`), not deleted, and the
workspaces it owned are the new person's from then on: each one's document names the new person
as its owner, with the workspace key derived from it (`identity.md`). A device that shares a
workspace with anyone does not take another person: those it let into its own, and those who let
it into theirs, know it as its old one.

Either side may show the code. The one that shows it is the **offering** device; the one that
enters it dials the other and is the **entering** device.

## The code

Six words from `pairing-words.json` (256 words, so 48 bits), made from random bytes by the offering
device, valid for five minutes and used once. Three wrong proofs void it. It is shown as:

- the words, in order, separated by spaces or hyphens: `amber-canal-drift-…`;
- a link, `hivemind://pair/<base64url of the JSON below>`, and a QR code of the link.

```json
{ "v": 1, "device": "<offering device's key hex>", "addrs": ["<ip:port>", …], "relay": "<url>" | null,
  "code": "<the six words, hyphen-separated>", "name": "<the offering device's name>", "kind": "app" | "host",
  "admission": { "access": "<url>", "voucher": { … } | null } }
```

A phone reads a link from its QR code; `kind` is the offering device's, so never `phone`.

`admission` (0.6) is there when the offering device is on a network with an access service
(`network-access.md`), as an invite carries it: on a `closed` network, a `visit` voucher it signed,
naming no device, for one use, expiring with the code; on an `open-pow` one, none (the entering
device registers). A device entering the code from elsewhere gets onto that network with it first,
redeeming the voucher or registering, and then dials the offering device through `relay`. An
`admission` whose `access` is not an `http:` or `https:` URL of at most 500 characters is none; a
`voucher` that is not an object is none.

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
     "certificate": { … its device certificate … }, "addrs": ["<ip:port>", …], "relay": "<url>" | null,
     "shares": true }
   ```

   `shares` (0.2, optional) says the entering device shares a workspace with someone, its own or
   someone else's: it must not take another person, so an offering app refuses it.

   A phone (0.3) has no certificate yet and shares nothing, so it sends neither:

   ```json
   { "v": 1, "pair": "prove", "proof": "<proof(\"entering\")>", "name": "<its name>", "kind": "phone",
     "addrs": ["<ip:port>", …], "relay": "<url>" | null }
   ```

   The offering device checks that a code is open, that the proof is right (compared in constant
   time; a wrong one counts against the code), that the certificate verifies and names the device
   that connected (from any device but a phone), that one of the two gives (an app; a host refuses
   a host or a phone), and, when it is an app, that the entering device does not share. It answers

   ```json
   { "ok": true, "proof": "<proof(\"offering\")>", "name": "<its name>", "kind": "app" | "host", "certificate": { … },
     "addrs": [ … ], "relay": … }
   ```

   and, when it is the giver, also `"person": "<the person seed, hex>"`, or, to a phone, in its
   place `"yours": { … }`: a device certificate naming the phone, signed by the person key; and
   to a phone, when the app is on a network other than the local one (0.5), `"network"`: that
   network, as `network-profile.md` has it (a built-in's name, or its signed profile). The
   entering device checks that proof, and that the person given is the one that signed the giver's
   certificate (a phone: that `yours` verifies, names the phone itself and that same person),
   before it uses anything in the answer. From here each knows the other holds the code.
2. **Give** (only when the entering device is the giver). It sends
   `{ "v": 1, "pair": "give", "proof": "<proof(\"give\")>", "person": "<the person seed, hex>" }`,
   and the offering device, which proved itself in step 1, checks the proof and that the person is
   the one that signed the certificate the giver showed, and answers `{ "ok": true }`.

A failure answers `{ "ok": false, "error": "expired" | "wrong-code" | "malformed" | "not-this-device" | "same-kind" | "shares" }`
(`same-kind`: neither of the two gives, as for two hosts, or a host and a phone; `shares`: the
entering device would take the person, and shares a workspace).
A host that already owns a workspace someone else was let into does not offer or enter a code:
taking another person would make that workspace no longer its owner's.

## After

- The taker keeps the person key it was given and certifies its own device with it. The giver
  certifies the taker's device with the same key, so each holds a certificate for the other that
  names the person. A phone keeps the certificate it was given as its own (`device.cert`), and no
  person key.
- Each keeps the other in its list of the person's devices, `devices.json` next to its keys: its
  key, name, kind, where it says it is reached (`addrs`, `relay`), when it was paired, and that
  certificate.
- The person's devices are the owner of every workspace the person owns, wherever it is hosted:
  a host admits them, and tells them which workspaces it holds. Relays still admit by enrolment
  (`network-access.md`).
- A phone is listed as one of the person's devices, and is never a place to run a frame, to host a
  workspace or to move one to.
- A phone given a network that verifies keeps it, and reaches the person's devices through it
  from then on: its relays and its lookup server, as well as the local network. On a `closed`
  network the app vouches for the phone as it pairs (`network-access.md`), as it does for any of
  the person's devices that reaches it; on an `open-pow` one the phone registered itself, as the
  link's `admission` said (0.6). A network
  that does not verify is not taken. Pairing again with the same person's app keeps the network
  when that app gives none; with another person's, the phone takes that one's network, or none.

## Unpairing

A device forgets another when the person unpairs it there: it is no longer among the person's
devices to it, is let in no more, and is told nothing more (`push.md`). A phone may also unpair
itself (0.4): on the `device` stream of its connection to the device (`needs.md`, "Asking") it
sends `{ "t": "unpair" }`, the device answers `{ "t": "unpair", "ok": true }`, and the phone hangs
up. The device forgets it once it has (forgetting it first would cut the connection, and the answer
with it), or lets it go after a few seconds and forgets it then. The phone forgets the device
whether or not it could tell it; a device it could not tell still lists the phone until the phone
is unpaired there too. Unpairing is recorded in the device's audit log, as whoever asked for it.

The cases in `../conformance/pairing.json` (proofs, codes, links, and a phone pairing with an app,
message by message) decide whether an implementation follows this.
