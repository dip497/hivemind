# Identity (0.1)

Who a device, a person and a workspace are (R3 in `docs/design/multiplayer-2026-09-28.md`).
Every key is Ed25519 (RFC 8032). A key's secret is its 32-byte seed; a key is named by its public
key in lowercase hex, 64 characters, which for a device is its iroh `EndpointId`. The cases in
`../conformance/identity.json` decide whether an implementation follows this.

## Keys

- **Device key.** Made once per machine, from 32 random bytes, and never leaves it.
- **Person key.** Made on a person's first device; their other devices receive it when they are
  paired with that one, over the end-to-end encrypted pairing channel. Roles are granted to a
  person, by this key, and follow them to each of their devices.
- **Workspace key.** Derived, never stored: the 32-byte seed is
  `HKDF-SHA256(IKM = the owner's person seed, salt = none, info = "hive-workspace" ‖ workspaceId)`
  (RFC 5869; no salt is the same as 32 zero bytes). Every device holding the owner's person key
  derives the same one; no one else can. It signs where the workspace is hosted.

A workspace's id is 16 random bytes in lowercase hex, made once, when the workspace is. Its
document says whose it is, in its `meta` map: `workspaceId`, `owner` (the owner's person key) and
`workspacePublicKey` (the workspace key's public half), written by the owner's device the first
time it writes the document and never changed after.

## Device certificate

"Device `device` is person `person`'s", signed by the person key:

```json
{ "v": 1, "person": "<hex>", "device": "<hex>", "issuedAt": <ms since the epoch>, "signature": "<hex>" }
```

The signature is Ed25519 over these bytes:

```
"hive/device-certificate/1\n"   26 bytes of ASCII
person                          the person's public key, 32 bytes
device                          the device's public key, 32 bytes
issuedAt                        u64, big-endian
```

A certificate verifies when every field has its form and the signature is the person key's over
those bytes. Anything else does not verify.

## Where keys are kept

Each machine keeps its device key, the person key it holds and its own device certificate in a
directory only its user can open (0700), one file each (0600): `device.key` and `person.key` hold
the seed in lowercase hex, `device.cert` the certificate as above. The app keeps them in
`<userData>/identity`, `hive host` in the same place under its config directory. They are made on
first use and never replaced by the app itself: pairing replaces the person key and the
certificate, and unpairing forgets them.
