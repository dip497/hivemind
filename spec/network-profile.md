# Network profile (0.1)

Where a network's servers are (R16 in `docs/design/multiplayer-2026-09-28.md`, §13.2): its relays,
its lookup, access and push services, and who its admin is, in one file the admin signs. A device
uses one profile at a time, its **home network**; a workspace on another network adds that
network's relays for itself only. The cases in `../conformance/network-profile.json` decide
whether an implementation follows this.

## The profile

JSON text:

```json
{
  "v": 1,
  "name": "Example Corp",
  "relays": [{ "url": "https://relay.hive.example.com" }],
  "lookup": "https://dns.hive.example.com/pkarr",
  "access": { "url": "https://access.hive.example.com", "policy": "closed" },
  "push": { "url": "https://push.hive.example.com", "kinds": ["unifiedpush"] },
  "admin": "<the admin's public key, hex>",
  "local": { "mdns": true },
  "issuedAt": 1790000000000
}
```

- `v` is 1. `name` is 1 to 64 characters. `relays` may be empty; `lookup`, `access` and `push`
  may be null or absent. `local.mdns` (default true): devices on the same network find each other
  by mDNS, whatever else the profile names.
- `access.policy` is `open-pow` (any device may register its key with a small proof of work) or
  `closed` (devices the admin enrolled, or an enrolled device did, and those vouched for).
- `lookup` is a pkarr relay: a device on the network publishes there which relay it is reached
  through, signed by its key (`PUT <lookup>/<z-base-32 of its id>`), and finds another by its id
  alone; workspaces' host records are kept there too (`host-record.md`). `hive-net serve` serves
  it at `/pkarr`, beside the relay, and the access service at `/access`.
- A reader ignores a field it does not know (a minor version adds them).

## The signed file

```json
{ "profile": "<the profile's JSON text>", "signature": "<hex>" }
```

The signature is Ed25519 (RFC 8032) by the key `admin` names, over these bytes:

```
"hive/network-profile/1\n"   23 bytes of ASCII
the profile's text           its UTF-8 bytes, exactly as they are in the file
```

The text is signed as it is, so nothing is canonicalised: an implementation parses it only after
the signature verifies against the `admin` it names. A profile that names no admin, or whose
signature does not verify, is not used.

A profile that replaces the home network's (the same `name`) must be signed by the same admin.
Another network is the person's choice to make, shown with who signed it.

## A link

`hivemind://network/<the signed file's JSON, base64url without padding>`.

An **enrolment link** is the same, its file carrying one more field, `enrol`: a voucher of kind
`enrol` signed by the admin that names no device (`network-access.md`). The device that uses the
link redeems it at the network's access service, and is enrolled. `hive-net access enrol-link
<signed profile> --admin <key>` makes one (for one device, for seven days, unless told
otherwise).

## Built in

Two profiles are part of the app and not signed: `local`, *Local network* (no servers, mDNS on),
the default; and `hosted`, *hivemind* (its relays, lookup, access and push services, §12),
used only once chosen.
