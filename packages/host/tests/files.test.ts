// file.read answers text only (files.ts): a binary file and one over the size an editor takes are
// refused with a code a client shows, so nothing reads them as text and writes that back over them;
// a text file comes back byte for byte, its line endings as they are on disk.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceServer } from "@hivemind/workspace-api/server";
import { workspaceDomains } from "../src/domains.ts";
import { LARGEST_TEXT_FILE } from "../src/files.ts";

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-files-")));
after(() => fs.rmSync(repo, { recursive: true, force: true }));
const server = new WorkspaceServer(workspaceDomains, new Intents(new AuditLog({ file: path.join(repo, "..", `${path.basename(repo)}-audit.jsonl`) })));
const window = { actor: { kind: "person" } as const, send: () => {}, closed: new AbortController().signal };
const read = (file: string) => server.answer("file.read", [repo, file], window);

test("a file with a NUL in its first 8 KB is refused as binary", async () => {
  fs.writeFileSync(path.join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]));
  assert.deepEqual(await read("logo.png"), { error: { code: "UNSUPPORTED", message: "This file is binary" } });
});

test("a file over the largest text file is refused, saying its size", async () => {
  fs.writeFileSync(path.join(repo, "big.log"), Buffer.alloc(LARGEST_TEXT_FILE + 1, "a"));
  assert.deepEqual(await read("big.log"), { error: { code: "FILE_TOO_BIG", message: "This file is too large to edit, 5.0 MB" } });
});

test("a text file comes back as it is on disk, its CRLF line endings too", async () => {
  fs.writeFileSync(path.join(repo, "notes.txt"), "one\r\ntwo\r\n");
  assert.deepEqual(await read("notes.txt"), { result: "one\r\ntwo\r\n" });
});
