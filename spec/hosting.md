# Hosting (0.2)

Moving a workspace's hosting from one of its owner's devices to another (§5.7 B, F and §5.8 in
`docs/design/multiplayer-2026-09-28.md`, M3): the device hosting it (the **old host**) hands the
new one (the **new host**) the workspace's document and its access list; whoever is connected to
it is told where it went, with a host record (`host-record.md`), and follows by themselves, with
no new invite. Frames stay where they are: their terminals keep running on the machine they ran
on. Another of the owner's devices may ask the device hosting a workspace to hand it over to it
(**move**): how a workspace comes back to the computer it was moved from.

## Who may

- Only the owner's devices: the two devices are one person's (`pairing.md`), and the new host
  takes a workspace only from a device in its list of that person's devices, and only one whose
  document says it is that person's and is the workspace named (`ownership` in the document:
  `owner` its person's id, `workspaceId` the workspace's).
- Only the device hosting it moves it: one whose list says the workspace is hosted on another
  device refuses, and so does one with a workspace whose document does not say whose it is yet.
- Only the owner's devices ask for it (**move**); anyone else, a guest in it among them, is
  refused.

## The `hosting` stream

The old host first signs the host record naming the new host, at the move's `seq`, with the
workspace's key (a move it cannot sign is not made). It dials the new host, and they speak on the
connection's `hosting` stream, one JSON message per text frame.

1. **take**, old → new:

   ```json
   { "t": "take", "workspace": "<the workspace's 16-byte id, hex>", "seq": 2, "root": "<the workspace's folder on the old host>",
     "doc": "<base64: the workspace document, a Loro snapshot>", "list": "<base64: its access list, a Loro snapshot>" }
   ```

   `seq` counts the moves, as the host record does: the one the old host knows plus one (a
   workspace never moved is at 1).

2. **The answer**, new → old: `{ "ok": true }`, or `{ "ok": false, "error": "<why>" }`. The new host
   refuses a device that is not its person's, a malformed message, a `seq` not above the last one
   it knows for the workspace, and a document that is not its person's workspace of that id. The
   old host waits 30 s for it; a refusal or no answer leaves the workspace where it was, its
   folders named as they were.

   Taking it, the new host keeps the document as the workspace at
   `machine://<old host's device id>/<root>` (where a tile in no frame of its own runs, and what
   `hive://<workspaceId>` reads as there), and the list as that workspace's; records that it hosts
   it, at `seq`; lets in whom the list lets in; and says its host record, at `seq`, where there is
   a lookup server. A `root` that names a device already (`machine://<device id>/<path>`: the
   workspace was moved before) is kept as it is, unless it names the new host itself: then the
   workspace is back at its own folder, `path`, merged into what the new host kept of it there,
   and every folder of a frame named by the new host's id is plainly its own again (`/path`).

3. The old host, once it is taken:
   - records in its list that the new host hosts it, at `seq`, with the record it signed;
   - sends each device connected to the workspace the **moved** notice (below), takes no more of
     its changes, and closes its connection with the reason `moved`;
   - sends what changed while the move went, **catch-up**, old → new:
     `{ "t": "catch-up", "workspace": "<id>", "doc": "<base64: a Loro update since what take carried>" }`,
     which the new host imports only into a workspace it hosts. It is not answered.

   From then on the old host no longer says the workspace's record, and opens the workspace as
   any of the owner's devices does: by its id, from the new host.

**move**, from one of the owner's devices to the device hosting the workspace:
`{ "t": "move", "workspace": "<id>" }`, answered as **take** is, once the workspace is moved: the
device hosting it moves it to the one asking, as above (it dials it and hands it over), and
answers `{ "ok": true }`, or `{ "ok": false, "error": "<why>" }` when it does not (the asker is not
one of the owner's devices, the workspace is not here or is hosted elsewhere, the asker refused
it). The asker waits 30 s.

## Frames stay where they are

Before it hands the document over, the old host names each folder of a frame that is its own
(`workspacePath` and `worktreePath`, an absolute path) as a folder on it,
`machine://<old host's device id>/<path>`, so the new host runs that frame's terminals in the old
host's PTY daemon, on the `pty` stream (owner's devices only), where they were running already.
A folder that names a machine already is left as it is.

## The notice

On the workspace's `sync` stream, the one that keeps a device's copy in step with the host:

```json
{ "t": "moved", "host": "<the new host's device id, hex>", "seq": 2, "record": "<base64: the signed packet>" }
```

`record` is the host record as `host-record.md` keeps it at a lookup server (the packet without
its leading public key). The connection closes after it. A device that is sent it:

- checks the record against the workspace's public key it knows (an invite carries it, `k`):
  signed by that key, and naming the `host` and `seq` the notice does; a notice whose record does
  not is ignored (a device joined by an invite from before invites carried the key follows on its
  host's word);
- keeps `host` as the workspace's host, with `seq`: a host record after as many moves or fewer
  (one the old host said before, still at the lookup server) does not change it;
- dials it at once.

A device that comes to the old host for the workspace later (its `hello` on `sync`) is sent the
same notice and closed with `moved`.

## Not yet

Taking over from a host that is gone (§5.7 E), and the owner's other devices keeping the document
and the list in step (§5.8, Replicas), come later.
