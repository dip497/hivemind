# Push (0.5)

What happens while the person is away, told to their phone (M5, design §9.2 "Push notification"):
an agent on one of their devices begins waiting on them, finishes or fails; and a device the phone
found away is back (0.2); and someone asks to join one of their workspaces while none of their
windows is there to ask (0.5). The device tells each phone that gave it where to, encrypted to that
phone, so that whatever carries the message reads nothing of it; a phone that cannot be reached
at an address of its own is told through its network's push server (0.3), which passes on what
the devices it named sign, unread. The cases in `../conformance/push.json` decide whether an
implementation encrypts, decrypts and signs as this says.

## Subscribing

A phone gives each of the person's devices it paired with where it is told, on the `device`
stream (`needs.md`, "Asking"), as a Web Push subscription:

```json
{ "t": "push", "endpoint": "https://push.example/…", "p256dh": "<its push key>", "auth": "<its secret>", "sign": true }
```

- `endpoint` is an `http:` or `https:` URL of at most 1000 characters: a push service's
  (UnifiedPush, or the network's push server, below), or the phone's own on the local network.
- `sign` (0.3), when `true`, says the endpoint is a push server's that passes on only what the
  devices the phone named sign: the device signs each notice it posts there ("Sending"). Anything
  else, or nothing, and it signs none.
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
  "since": 1790000000000, "decide": true }
```

- `t` is `needs` when an agent in a workspace the device holds begins waiting on the person
  (`needs.md`): a wait whose `since` is not the one it waited with before. It is `finished` when
  the agent's status becomes `done`, and `failed` when it becomes `failed` (`status.md`). Nothing
  else is told: not working, not waiting for an approval, not the same wait again (its title
  changing, say), not done or failed again.
- `workspace`, `tile` and `kind` are as `needs.md` has them, `kind` for `needs` alone. `since` is
  when the status became what it is. `decide` (0.4) is as there too: `true` on a permission the
  device can allow or deny, so the phone may put Allow and Deny on the notification itself and
  answer from it (`needs.md`, "Answering"), and left out otherwise. `name` and `agent` are as there, the first 200 characters
  (Unicode code points) of each (0.3: `name` too), so that a notice fits what Apple's push service
  carries.
- An agent first seen, as the device starts and brings back its sessions' statuses, or a session
  started anew in its tile, is told of from its next change on. What it waits on now is in the
  list (`needs.md`).
- An agent whose tile is not on its workspace's board yet (a window saves a new tile a moment
  after it starts) is told of once it is, unless its status changes first.

A phone told of the same `workspace`, `tile` and `since` twice, by two devices, shows it once.

## Back

A device that starts, or wakes from sleep, tells each phone subscribed there that it is back (0.2):

```json
{ "v": 1, "t": "back", "device": "<its key, hex>", "name": "<what it is called>", "since": 1790000000000 }
```

once it is on its network: as it starts, when it has any of the person's other devices (or
anything shared from it) to be reached by, and as it wakes, once it is online again. `name` is its
first 200 characters. `since` is when it was back. It is sent as a notice is, with `Urgency:
normal`.

A phone shows it only for a device it found away (`needs.md`, "Asking") at or before `since`, and
does not count that device away from then on. One it did not find away, or found away again after
`since` (a push service keeps a message for as long as its `TTL`, and gives it late), it does not
show.

## Join

Someone asking to join a workspace of the person's hosted on a device (`workspace-api.md`,
`people.*`), while none of the person's windows is connected to it there, is told to each phone
subscribed there (0.5):

```json
{ "v": 1, "t": "join", "workspace": "<its id, hex>", "name": "api", "req": 3, "who": "Noor", "role": "edit", "since": 1790000000000 }
```

`name` is the workspace's name, `who` what the person asking calls themselves (`someone` when they
gave nothing), each its first 200 characters; `role` the role their link gives; `req` the question,
as `people.answer` names it; `since` when it was asked. It is sent as a notice is, with `Urgency:
high`. The phone may offer Allow and Deny on it and answer with `people.answer`, on the workspace
`workspace` (`workspace-api.md`, "Peers"); an answer after 170 s, or after another, does not count.

## Sending

The notice, as JSON in UTF-8, is encrypted to the phone as RFC 8291 says, over RFC 8188's
`aes128gcm`: with a key pair and a salt of its own for each message, in one record of record size
4096, the delimiter 2 after the notice and no other padding; the whole body at most 4096 bytes
(RFC 8291 §4), so a notice of at most 3993 (0.3). The body is

```
salt (16 bytes) · record size (4, 4096) · key length (1, 65) · the sender's public key (65) · the record
```

and is posted to the endpoint:

```
POST <endpoint>
TTL: 86400
Urgency: high                    (normal for finished, failed and back)
Content-Encoding: aes128gcm
Content-Type: application/octet-stream
Hive-Sender: <the device's key, hex> <the time, ms since the epoch> <signature, hex>
```

`Hive-Sender` (0.3) goes to an endpoint whose subscription says `sign`, and nowhere else: the
device key's signature, Ed25519, over

```
hive/push-notice/1\n · the phone's handle · \n · the time, in decimal · \n · SHA-256 of the body (32 bytes)
```

where the handle is the last segment of the endpoint's path (`<push>/<handle>`, below), so that a
push server passes on only what a device the phone named signed for that phone. A redirect is not
followed.

An answer of 404 or 410 says the push service no longer knows the phone: the device forgets its
subscription. Any other answer, or none, leaves it as it is, and the notice is not sent again. The
device sends no VAPID header (RFC 8292); a push server sends its own (below).

## Receiving

The phone decrypts each body with its push key and secret. It refuses one of more than one record
(a record size under 18, or a record longer than it), one whose sender's key is not given whole
(65 bytes, uncompressed: 0.3), one that is not for it or was changed on its way (the record does
not decrypt), and one cut short (its record's delimiter is not 2). What it
decrypts is a notice, or a device back, as above, in version `v`.

## The push server (0.3)

A network's profile may name a push server (`push`, `network-profile.md`): the push role of
`hive-net serve` (design §12.4). It tells a phone what the person's devices post it, unread, where
the phone says: at a UnifiedPush distributor (`unifiedpush`: the body as it came), or through
Apple's push service (`apns`) or Google's (`fcm`), as the profile's `kinds` says it can.

### Registering

```
POST <push>/register
{ "v": 1, "device": "<the phone's key, hex>", "platform": "unifiedpush", "token": "<where>",
  "sandbox": false, "senders": ["<a device's key, hex>", …], "at": 1790000000000,
  "signature": "<hex>" }
```

- `token` is where the phone is told, at most 1000 characters with no space or control character
  in them: a distributor's address (`unifiedpush`), the phone's device token in hex (`apns`), or
  its registration token (`fcm`). `sandbox` asks for Apple's development service, for a build not
  from the store.
- A distributor's address is `https:` on the internet; or, when the server serves networks of its
  own (`--push-allow <network>`, a building's, say), one on those networks, `http:` too. An address
  on the server's own networks it does not serve (private, shared, link-local or loopback, written
  as such or a name looked up to one) is refused, so that no one can have it post into them.
- `senders` are the devices that may tell the phone, at most 100: the person's, those it paired
  with and those it learned of (`pairing.md` 0.7).
- `signature` is the phone's device key's, Ed25519, over

  ```
  hive/push-register/1\n · device · \n · platform · \n · token · \n · 1 or 0 (sandbox) · \n ·
  the senders, joined by "," · \n · at, in decimal
  ```

It is answered `200 { "handle": "<16 random bytes, hex>" }`, the same handle each time the phone
registers there; the phone gives its devices `<push>/<handle>` as its subscription's `endpoint`,
with `sign: true` and its push key and secret as above. Or `403 { "error": "…" }`: a registration
whose `at` is more than ten minutes from the server's clock, not signed by the phone, no later than
the one kept (the same one sent again), for a platform the server is given no credentials for, or
for an address it does not post to. Beside the network's access role, a phone that role does not
allow (`network-access.md`) is refused.

The phone registers anew, under the same handle, as it starts (a token can change) and whenever
the devices that may tell it change, before it gives a device it names its subscription: as it
unpairs one, a device it no longer names posts it nothing more.

### Posting

A device posts a notice to `<push>/<handle>` as "Sending" says, `Hive-Sender` and all:

| Answer | |
|---|---|
| 201 | passed on |
| 400 | not a Web Push message (one `aes128gcm` record from a 65-byte key, the body at most 4096 bytes), or no `TTL` |
| 401 | no `Hive-Sender`, or not the signature of the device it names over this phone's handle and this body, or its time more than ten minutes from the server's clock |
| 404 | no phone has that handle, or the phone did not name that device (alike) |
| 409 | the same notice (device, time and body) was passed on before |
| 410 | the phone's service no longer knows it: its registration is dropped |
| 413 | more than 4096 bytes, or more than the phone's service carries |
| 429 | more than 60 notices for one phone at once (then one a second), or 600 requests from one address at once (then ten a second; an IPv6 address counts as its /64) |
| 502 | the phone's service did not take it, tried a second time after a moment when it was busy or failing; what went wrong is the server's to log, never the phone's address |

### Passed on

Within ten seconds, all told:

- **UnifiedPush.** `POST <token>` with the body as it came, `TTL` (at most 28 days), `Urgency`,
  `Content-Encoding: aes128gcm`, `Content-Type: application/octet-stream`, and
  `Authorization: vapid t=<token>, k=<key>` (RFC 8292): the server's VAPID key, which the profile
  names (`push.vapid`) for the phone to give its distributor, signing a token for the address's
  origin, good for 12 hours. Through no proxy, following no redirect. 2xx is delivered; 404 or 410,
  gone; 413, too large.
- **APNs.** `POST https://api.push.apple.com/3/device/<token>` (`api.sandbox.push.apple.com`
  for `sandbox`), over HTTP/2, with a provider token (ES256, made again every 30 minutes, or when
  Apple says it expired), `apns-topic`, `apns-push-type: alert`, `apns-priority` 10 for
  `Urgency: high` and 5 otherwise, and `apns-expiration` (now and the TTL; 0 for none). The payload
  is `{"aps":{"alert":{"body":"Something on your devices needs a look","title":"hivemind"},"mutable-content":1},"m":"<the body, base64url>"}`,
  at most 4096 bytes (a body of at most 2987): the phone's Notification Service Extension decrypts
  `m` and shows the notice in place of the alert. 410, or 400 with `BadDeviceToken`, is gone;
  `DeviceTokenNotForTopic` is a failure, since a server given the wrong bundle id would otherwise
  drop every phone.
- **FCM.** `POST https://fcm.googleapis.com/v1/projects/<project>/messages:send` with the service
  account's access token (made again when Google answers 401), a data message:
  `{"message":{"token":"<token>","data":{"m":"<the body, base64url>"},"android":{"priority":"HIGH","ttl":"86400s"}}}`
  (`NORMAL` for any other urgency; data at most 4096 bytes, a body of at most 3071); the phone's
  app decrypts `m` and makes the notification. 404 or 400 whose details say `UNREGISTERED` is
  gone, and nothing else is.

### What the server keeps

Each phone's registration, by handle, and its VAPID key, readable by its user alone. In memory,
for ten minutes, which notices it passed on (the device, the time and the body's hash), and how
many requests each phone and each address made lately. Nothing a notice says: it cannot read one,
and keeps no body.
