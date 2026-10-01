# Push (0.1)

What happens while the person is away, told to their phone (M5, design §9.2 "Push notification"):
an agent on one of their devices begins waiting on them, finishes or fails. The device that runs
the agent tells each phone that gave it where to, encrypted to that phone, so that whatever
carries the message reads nothing of it. The cases in `../conformance/push.json` decide whether an
implementation encrypts and decrypts as this says.

## Subscribing

A phone gives each of the person's devices it paired with where it is told, on the `device`
stream (`needs.md`, "Asking"), as a Web Push subscription:

```json
{ "t": "push", "endpoint": "https://push.example/…", "p256dh": "<its push key>", "auth": "<its secret>" }
```

- `endpoint` is an `http:` or `https:` URL of at most 1000 characters: a push service's
  (UnifiedPush, or the push server of design §12.4), or the phone's own on the local network.
- `p256dh` is the phone's push key, a P-256 public key, uncompressed (65 bytes), and `auth` a
  secret of 16 bytes, each in base64url without padding. The push key is kept apart from the
  phone's device key (`identity.md`) and is used for nothing else; the secret goes only to the
  person's devices, so a message the phone can decrypt was sent by one of them.

The device answers `{ "t": "push", "ok": true }` and tells the phone at `endpoint` from then on, in
place of wherever it told it before; or `{ "t": "push", "ok": false, "error": "…" }`, "not a push
subscription" for one that is not as above. A device takes a subscription from one of the
person's phones only (a computer of theirs that sends one is answered nothing), keeps it readable
by its user alone, and forgets it when that phone is unpaired there.

## What is told

```json
{ "v": 1, "t": "needs", "workspace": "<the workspace's id>", "name": "<the workspace's name>",
  "tile": "<the agent's tile>", "agent": "<what the agent is called>", "kind": "permission",
  "since": 1790000000000 }
```

- `t` is `needs` when an agent in a workspace the device holds begins waiting on the person
  (`needs.md`): a wait whose `since` is not the one it waited with before. It is `finished` when
  the agent's status becomes `done`, and `failed` when it becomes `failed` (`status.md`). Nothing
  else is told: not working, not waiting for an approval, not the same wait again (its title
  changing, say), not done or failed again.
- `workspace`, `name`, `tile` and `kind` are as `needs.md` has them, `kind` for `needs` alone.
  `since` is when the status became what it is. `agent` is as there, its first 200 characters
  (Unicode code points).
- An agent first seen, as the device starts and brings back its sessions' statuses, or a session
  started anew in its tile, is told of from its next change on. What it waits on now is in the
  list (`needs.md`).
- An agent whose tile is not on its workspace's board yet (a window saves a new tile a moment
  after it starts) is told of once it is, unless its status changes first.

A phone told of the same `workspace`, `tile` and `since` twice, by two devices, shows it once.

## Sending

The notice, as JSON in UTF-8, is encrypted to the phone as RFC 8291 says, over RFC 8188's
`aes128gcm`: with a key pair and a salt of its own for each message, in one record of record size
4096, the delimiter 2 after the notice and no other padding. The body is

```
salt (16 bytes) · record size (4, 4096) · key length (1, 65) · the sender's public key (65) · the record
```

and is posted to the endpoint:

```
POST <endpoint>
TTL: 86400
Urgency: high                    (normal for finished and failed)
Content-Encoding: aes128gcm
Content-Type: application/octet-stream
```

An answer of 404 or 410 says the push service no longer knows the phone: the device forgets its
subscription. Any other answer, or none, leaves it as it is, and the notice is not sent again. No
VAPID header (RFC 8292) is sent.

## Receiving

The phone decrypts each body with its push key and secret. It refuses one of more than one record
(a record size under 18, or a record longer than it), one that is not for it or was changed on its
way (the record does not decrypt), and one cut short (its record's delimiter is not 2). What it
decrypts is a notice as above, in version `v`.
