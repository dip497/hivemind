# Network access (0.1)

Who may use a network's relays (R16 in `docs/design/multiplayer-2026-09-28.md`, §12.3, §13.4):
the `access` role of `hive-net serve`, which a relay asks about each device that connects. A
device is named by its key (its iroh `EndpointId`, `spec/identity.md`); every message that changes
what the service allows is signed, so the service needs no accounts.

## Who is allowed

A device may use the relays while it is:

- **enrolled**: for good, until revoked. The admin enrols devices, and so may any enrolled device
  (pairing a new device of yours with one already on the network);
- **registered**, on an `open-pow` network: it proved it holds its key and did a small proof of
  work; or
- **visiting**: until the voucher that admitted it expires, or it is revoked.

## Vouchers

A voucher is a signed, time-limited, counted admission:

```json
{ "v": 1, "kind": "enrol" | "visit", "by": "<key hex>", "device": "<key hex>" | null,
  "nonce": "<16 bytes hex>", "expires": <ms since the epoch>, "uses": <n>, "signature": "<hex>" }
```

The signature is Ed25519 by `by`, over:

```
"hive/voucher/1\n"   15 bytes of ASCII
kind                 1 byte: 0 enrol, 1 visit
by                   32 bytes
device               32 bytes; zeros when null
nonce                16 bytes
expires              u64, big-endian
uses                 u32, big-endian
```

- An `enrol` voucher is signed by the admin or an enrolled device; a `visit` voucher also by a
  registered device on an `open-pow` network.
- A voucher that names a `device` is given to the service by its signer (`POST /vouch`): that
  device is enrolled, or visits until `expires`.
- A voucher that names none is carried to a device (an invite link, an enrolment link), which
  redeems it (`POST /redeem`) up to `uses` times in all, before `expires`, proving it holds its
  key with `proof`, Ed25519 by the device over `"hive/redeem/1\n"` (14 bytes) ‖ nonce ‖ device.

## Registering (`open-pow`)

`POST /register {device, at, nonce, signature}`: `bytes = "hive/register/1\n"` (16 bytes) ‖
device ‖ at (u64, ms) ‖ nonce (u64), both big-endian; `signature` is the device's over `bytes`;
SHA-256 of `bytes` has at least the service's number of leading zero bits (`GET /pow` →
`{"bits"}`), and `at` is within ten minutes of the service's clock.

## Revoking

`POST /revoke {device, by, at, signature}`, the signature by `by` over `"hive/revoke/1\n"`
(14 bytes) ‖ by ‖ device ‖ at (u64). The admin revokes anyone; a device revokes a visit it vouched
for.

## The service

| Request | Answer |
|---|---|
| `POST /vouch`, a voucher that names a device | `{"ok": true}`, or 403 `{"error"}` |
| `POST /redeem {voucher, device, proof}` | the same |
| `POST /register {device, at, nonce, signature}` | the same |
| `POST /revoke {device, by, at, signature}` | the same |
| `GET /allowed/<device>` | `true` or `false`: what a stock relay's `access.http` asks |
| `GET /pow` | `{"bits"}` |
| `GET /healthz` | `ok` |

What it allows is kept across restarts, and nothing else: no addresses, no traffic.
