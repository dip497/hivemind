// file.stat and file.bytes (file-facts.ts): what a path is before it is opened, and a picture's bytes,
// never reaching outside the repo, a symlink out of it included.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceServer } from "@hivemind/workspace-api/server";
import { workspaceDomains } from "../src/domains.ts";

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-file-facts-")));
const repo = path.join(base, "repo");
const outside = path.join(base, "secret.png");
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
fs.writeFileSync(path.join(repo, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
fs.writeFileSync(outside, "not yours");
fs.symlinkSync(outside, path.join(repo, "link.png"));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const server = new WorkspaceServer(workspaceDomains, new Intents(new AuditLog({ file: path.join(base, "audit.jsonl") })));
const window = { actor: { kind: "person" } as const, send: () => {}, closed: new AbortController().signal };
const ask = (method: "file.stat" | "file.bytes", file: string) => server.answer(method, [repo, file], window);

test("stat says a file's size, a folder, and null for nothing there", async () => {
  assert.deepEqual(await ask("file.stat", "shot.png"), { result: { kind: "file", size: 6 } });
  assert.deepEqual(await ask("file.stat", "src"), { result: { kind: "folder", size: 0 } });
  assert.deepEqual(await ask("file.stat", "gone.ts"), { result: null });
});

test("bytes come back as they are on disk", async () => {
  const r = await ask("file.bytes", "shot.png") as { result: { base64: string; size: number } };
  assert.deepEqual([...Buffer.from(r.result.base64, "base64")], [0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  assert.equal(r.result.size, 6);
});

test("neither reaches outside the repo, by a path or by a symlink", async () => {
  for (const method of ["file.stat", "file.bytes"] as const) {
    assert.equal((await ask(method, "../secret.png") as { error?: { code: string } }).error?.code, "BAD_REQUEST");
    assert.equal((await ask(method, "link.png") as { error?: { code: string } }).error?.code, "BAD_REQUEST");
  }
});
