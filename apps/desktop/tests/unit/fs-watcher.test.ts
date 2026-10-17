// A repo's file changes reach each client watching it as the workspace API's `file.changed`, until
// the client's connection closes (fs-watcher.ts). The repo is a git repo with no `.hivemind`, the
// case in which none reached anyone (a missing path watched first hid the tree from chokidar).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import type { Connection } from "@hivemind/workspace-api/server";
import type { EventMessage } from "@hivemind/workspace-api/protocol";
import { watchRepo } from "../../src/main/fs-watcher.ts";

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-fs-watch-")));
execSync("git init -q", { cwd: repo });
const clients: Array<{ close(): void }> = [];
after(() => {
  for (const c of clients) c.close(); // an open watch keeps the process alive
  fs.rmSync(repo, { recursive: true, force: true });
});

function client(): Connection & { received: EventMessage[]; close(): void } {
  const closing = new AbortController();
  const received: EventMessage[] = [];
  const c = { actor: { kind: "person" } as const, received, send: (m: EventMessage) => { received.push(m); }, closed: closing.signal, close: () => closing.abort() };
  clients.push(c);
  return c;
}
const changedPaths = (c: { received: EventMessage[] }) =>
  c.received.flatMap((m) => (m.event === "file.changed" && m.params[0] === repo ? (m.params[1] as { paths: string[] }).paths : []));
async function until(check: () => boolean, ms = 5_000): Promise<void> {
  for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 50))) {
    if (Date.now() > end) throw new Error("timed out");
  }
}

test("each client watching a repo is sent its changes until its connection closes", async () => {
  const [a, b] = [client(), client()];
  watchRepo(repo, a);
  watchRepo(repo, b);
  watchRepo(repo, a); // watching twice is watching once
  await new Promise((r) => setTimeout(r, 500)); // git's ignore list is read before the tree is watched
  fs.writeFileSync(path.join(repo, "first.txt"), "1");
  await until(() => changedPaths(a).length > 0 && changedPaths(b).length > 0);
  assert.deepEqual([changedPaths(a), changedPaths(b)], [[path.join(repo, "first.txt")], [path.join(repo, "first.txt")]]);

  a.close();
  fs.writeFileSync(path.join(repo, "second.txt"), "2");
  await until(() => changedPaths(b).length > 1);
  assert.deepEqual(changedPaths(a), [path.join(repo, "first.txt")]);
  assert.deepEqual(changedPaths(b), [path.join(repo, "first.txt"), path.join(repo, "second.txt")]);
});
