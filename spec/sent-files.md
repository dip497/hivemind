# Sent files (0.39)

A file an agent on a computer sends the person's phone: a store-and-forward mailbox on the computer,
fetched by a phone that is often away. The agent's words say a file was sent; the file itself is in
a list of its own, not the conversation, so an agent that keeps no session file can send one too.

## Sending

`agent.sendFile(tile, path)` (`workspace-api.md`), which `hive ctl send-file` calls, copies the file
into the app's data folder, `sent-files/`, readable by this user alone, and answers what it kept:

```json
{ "id": "<32 hex digits, random>", "tile": "<bare>", "name": "report.pdf", "size": 1234, "type": "application/pdf", "at": 1790000000000 }
```

- The copy is frozen: the file changing or going afterwards changes nothing sent.
- `name` is the file's name with no folder, without control or format characters, at most 200
  characters. No path on the computer leaves with it.
- Only a program on the computer may call it, and an agent only as itself.
- It is refused with `FILE_TOO_BIG` over 32 MiB, `NO_PHONE` with no phone paired here, `NO_AGENT` for
  a tile that runs no agent, and `UNSUPPORTED` for an agent on another machine.
- There is no approval step, and answering does not mean the phone has it: the answer says "ready".

## Keeping

A copy goes when it is 7 days old, when its agent has 50 newer, when the folder would pass 1 GiB
(oldest first), or when taken back (`agent.takeBackFile`). A list never names what has gone past its
time, and its bytes leave the disk at the next send or start.

## Fetching

The owner's devices alone, since no role names `agent.files` or `agent.filePiece`:

- `agent.files(tile)` answers the list, oldest first, and sends `agent.filesChanged(tile, files)`, the
  whole list, as it changes, until the caller goes.
- `agent.filePiece(id, offset)` answers `{data, size}`: up to 1 MiB as base64, and the whole size. A
  fetch that stops goes on from the bytes it has, as the copy never changes.

A phone asks by id, and never names a path. It takes no file whose `id` is not 32 hex digits, whose
`name` is empty, over 200 characters or holds `/` or `\`, or whose `size` is over 32 MiB; and it stops
when a piece's `size` differs from the list's, a piece is empty before the end, or more comes than
`size`.

## Showing

A phone never opens a sent file in its own origin: a blob of a sent page would run with it, and reach
the phone's keys. It draws only `image/png`, `image/jpeg`, `image/webp` and `image/gif`, and never
SVG. It hands a file on to the system's share sheet where there is one, else as a download of type
`application/octet-stream`. It keeps a file in memory until it is saved or its chat is left, and never
stores it.
