// The files and git of a frame on another of the person's devices (device-files.ts, M4 step 4):
// a window's call about a folder there (`machine://<device>/path`) goes to that device, which
// answers it on its own folder as for its owner; a call about anything else, or about a device
// that is not the person's, is not sent; and a device answers only the person's own devices, and
// only calls about folders.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import type { Link } from "@hivemind/workspace-host/hive-net";
import { WorkspaceServer } from "@hivemind/workspace-api/server";
import type { Answer } from "@hivemind/workspace-api/protocol";
import { workspaceDomains } from "../src/domains.ts";
import { deviceFolders, serveFiles } from "../src/device-files.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-device-files-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const LAPTOP = "a".repeat(64);
const DESKTOP = "b".repeat(64);
const STRANGER = "c".repeat(64);
const PERSON = "p".repeat(64);

/** Two ends of one connection: frames arrive in order, a moment after they are sent. */
function linkPair(a: string, b: string): [Link, Link] {
  const heard = [new Map<string, Set<(t: string) => void>>(), new Map<string, Set<(t: string) => void>>()];
  let close!: (why: string) => void;
  const closed = new Promise<string>((r) => { close = r; });
  const end = (i: number, peer: string): Link => ({
    peer,
    send: (stream, data) => void setImmediate(() => { for (const l of heard[1 - i]!.get(stream) ?? []) l(data); }),
    on: (stream, l) => {
      const set = heard[i]!.get(stream) ?? new Set();
      heard[i]!.set(stream, set.add(l));
      return () => { set.delete(l); };
    },
    // Each stream here is opened once, and heard by its name.
    streams: () => () => {},
    close: (why = "closed") => close(why),
    closed,
  });
  // `a`'s end hears from `b` (its peer), and the other way.
  return [end(0, b), end(1, a)];
}

/** The desktop, with a repository in a folder of its own, and the laptop asking it from `from`. */
function devices(from = LAPTOP) {
  const repo = path.join(tmp, `repo-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=T", ...args], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  fs.writeFileSync(path.join(repo, "notes.md"), "one\n");
  git("add", "notes.md");
  git("commit", "-q", "-m", "one");
  fs.writeFileSync(path.join(repo, "notes.md"), "one\ntwo\n");
  const [laptopEnd, desktopEnd] = linkPair(from, DESKTOP);
  const server = new WorkspaceServer([...workspaceDomains], new Intents(new AuditLog({ file: path.join(tmp, `audit-${Math.random()}.jsonl`) })));
  serveFiles(desktopEnd, server, (device) => (device === LAPTOP ? PERSON : null));
  let dialled = 0;
  const folders = deviceFolders({ mine: (device) => device === DESKTOP, dial: async () => { dialled++; return laptopEnd; } });
  return { repo, folders, dialled: () => dialled, closed: laptopEnd.closed };
}
const result = async (answer: Promise<Answer> | null): Promise<unknown> => {
  assert.ok(answer, "sent to the device");
  const a = await answer;
  if ("error" in a) throw new Error(`${a.error.code}: ${a.error.message}`);
  return a.result;
};

test("a window's call about a folder on another of the person's devices is answered there, on its own folder", async () => {
  const d = devices();
  const at = `machine://${DESKTOP}${d.repo}`;
  const status = (await result(d.folders.call("git.status", [at]))) as { files: Array<{ path: string }> };
  assert.deepEqual(status.files.map((f) => f.path), ["notes.md"]);
  assert.equal(await result(d.folders.call("file.read", [at, "notes.md"])), "one\ntwo\n");
  const diff = (await result(d.folders.call("git.diff", [at, { kind: "working" }]))) as { patch: string };
  assert.match(diff.patch, /\+two/);
  assert.equal(d.dialled(), 1, "one connection to the device, kept");
});

test("nothing else goes to a device: another device's folder, a folder here, or anything but folders", async () => {
  const d = devices();
  assert.equal(d.folders.call("git.status", [`machine://${STRANGER}${d.repo}`]), null);
  assert.equal(d.folders.call("git.status", [d.repo]), null);
  assert.equal(d.folders.call("terminal.open", [{ tileId: "hm:x", cwd: `machine://${DESKTOP}${d.repo}` }]), null);
  assert.equal(d.folders.call("store.core", [`machine://${DESKTOP}${d.repo}`]), null);
  assert.equal(d.folders.notice("presence.set", [`machine://${DESKTOP}${d.repo}`, null]), false);
  assert.equal(d.dialled(), 0);
});

test("a device answers only the person's own devices, and only about folders", async () => {
  const stranger = devices(STRANGER);
  // A device it does not know as the person's: it hangs up, and the call fails.
  const refused = await stranger.folders.call("git.status", [`machine://${DESKTOP}${stranger.repo}`]);
  assert.ok(refused && "error" in refused);
  assert.equal(await stranger.closed, "removed");

  // The person's own: a call that is not about a folder is refused.
  const d = devices();
  const server = new WorkspaceServer([...workspaceDomains], new Intents(new AuditLog({ file: path.join(tmp, "audit-x.jsonl") })));
  const [laptopEnd, desktopEnd] = linkPair(LAPTOP, DESKTOP);
  serveFiles(desktopEnd, server, () => PERSON);
  const answers: string[] = [];
  laptopEnd.on("files", (t) => answers.push(t));
  laptopEnd.send("files", JSON.stringify({ id: 1, method: "store.core", params: [d.repo] }));
  laptopEnd.send("files", JSON.stringify({ id: 2, method: "file.read", params: [d.repo, "notes.md"] }));
  for (let t = 0; t < 2_000 && answers.length < 2; t += 20) await new Promise((r) => setTimeout(r, 20));
  const byId = Object.fromEntries(answers.map((a) => JSON.parse(a) as { id: number; error?: { code: string }; result?: unknown }).map((a) => [a.id, a]));
  assert.equal(byId[1]?.error?.code, "FORBIDDEN");
  assert.equal(byId[2]?.result, "one\ntwo\n");
});
