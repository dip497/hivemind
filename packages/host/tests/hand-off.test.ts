// Hand off by bundle (hand-off.ts, M4): a participant's branch, from a clone on their machine,
// lands in the host's repository as `handoff/<who>/<branch>` at their tip, with a Diff tile on the
// board comparing it to the branch the host has checked out, and nothing of the host's own changed;
// whose history the host lacks the start of, it goes again with its whole history; a person lands
// again over their own hand-off, never over anyone else's or a branch of the host's; and the host
// takes only a branch named plainly, a git bundle, of 32 MB at most, from someone who may edit the
// board.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Intents, type Actor } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import type { Access } from "@hivemind/workspace-host/access";
import { WorkspaceClient } from "@hivemind/workspace-api/client";
import { WorkspaceServer } from "@hivemind/workspace-api/server";
import { ApiError } from "@hivemind/workspace-api/protocol";
import { peerTransport, servePeer, workspaceUrl, type TextChannel } from "@hivemind/workspace-api/peers";
import type { TileRecord } from "@hivemind/workspace-doc/shapes";
import { HAND_OFF_MAX_BYTES, handOff, handOffFrom } from "../src/hand-off.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-handoff-test-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let made = 0;
const W = "0123456789abcdef0123456789abcdef";
const PRIYA = "p".repeat(64);

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=T", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd: string, file: string, body: string) => { fs.writeFileSync(path.join(cwd, file), body); git(cwd, "add", file); git(cwd, "commit", "-q", "-m", file); };

/** The host's repository, on `main` with one commit; a clone of it on Priya's machine. */
function repos() {
  const dir = path.join(tmp, `r${made++}`);
  const host = path.join(dir, "host");
  fs.mkdirSync(host, { recursive: true });
  git(host, "init", "-q", "-b", "main");
  commit(host, "README.md", "hello\n");
  const guest = path.join(dir, "guest");
  git(dir, "clone", "-q", host, guest);
  return { dir, host, guest };
}

/** Two ends of a channel. */
function channel(): [TextChannel, TextChannel] {
  const toA = new Set<(t: string) => void>();
  const toB = new Set<(t: string) => void>();
  const closed = new Promise<never>(() => {});
  const end = (mine: Set<(t: string) => void>, theirs: Set<(t: string) => void>): TextChannel => ({
    send: (t) => queueMicrotask(() => { for (const l of theirs) l(t); }),
    on: (l) => { mine.add(l); return () => { mine.delete(l); }; },
    closed,
  });
  return [end(toA, toB), end(toB, toA)];
}

/** The host of the workspace whose repo is `repo`, and a person there (`person`, called `name`, with
 *  `access`) handing off from `folder`: the tiles it places on the board. */
function host(repo: string) {
  const placed: Array<{ repo: string; tile: TileRecord; name: string }> = [];
  /** Each bundle handed off, as it went. */
  const sent: string[] = [];
  const names = new Map<string, string>();
  const server = new WorkspaceServer([handOff({
    who: (c) => (c.actor.kind === "peer" ? { person: c.actor.person, name: names.get(c.actor.person) ?? "" } : { person: "", name: "" }),
    place: (r, tile, name) => placed.push({ repo: r, tile, name }),
  })], new Intents(new AuditLog({ file: path.join(tmp, `audit-${made++}.jsonl`) })));
  const as = (person: string, name: string, access: Access = "edit") => {
    names.set(person, name);
    const [hostEnd, guestEnd] = channel();
    const actor = { kind: "peer", person, device: person.slice(0, 1).repeat(64), access } as Extract<Actor, { kind: "peer" }>;
    servePeer(server, hostEnd, { actor, workspace: W, repo, holds: () => false });
    const client = new WorkspaceClient(peerTransport(guestEnd));
    return {
      client,
      handOff: (folder: string) => handOffFrom(folder, (branch, bundle) => { sent.push(bundle); return client.call("git.handOff", workspaceUrl(W), branch, bundle); }),
    };
  };
  return { placed, sent, as };
}
/** Whether a repository with nothing in it takes the bundle `base64`: it holds its branch's whole
 *  history. */
const whole = (dir: string, base64: string): boolean => {
  const empty = path.join(dir, `empty-${made++}`);
  fs.mkdirSync(empty);
  git(empty, "init", "-q");
  fs.writeFileSync(path.join(empty, "b.bundle"), Buffer.from(base64, "base64"));
  try { git(empty, "bundle", "verify", "b.bundle"); return true; } catch { return false; }
};
const failure = async (p: Promise<unknown>): Promise<{ code: string; message: string }> => {
  try { await p; } catch (e) { return { code: e instanceof ApiError ? e.code : "thrown", message: e instanceof Error ? e.message : String(e) }; }
  return { code: "ok", message: "" };
};

test("a participant's branch lands in the host's repository as handoff/<who>/<branch> at their tip, with a Diff tile on the board comparing it to the host's branch; nothing of the host's own changes", async () => {
  const r = repos();
  git(r.guest, "checkout", "-q", "-b", "feature");
  commit(r.guest, "feature.txt", "from priya\n");
  const before = { head: git(r.host, "rev-parse", "HEAD"), branch: git(r.host, "symbolic-ref", "--short", "HEAD") };
  const h = host(r.host);

  const landed = await h.as(PRIYA, "Priya").handOff(r.guest);
  assert.deepEqual(landed, { branch: "handoff/priya/feature", base: "main" });
  assert.equal(h.sent.length, 1);
  assert.equal(whole(r.dir, h.sent[0]!), false, "only what it adds to what the clone tracks went");
  assert.equal(git(r.host, "rev-parse", "handoff/priya/feature"), git(r.guest, "rev-parse", "feature"), "at their tip");
  assert.deepEqual({ head: git(r.host, "rev-parse", "HEAD"), branch: git(r.host, "symbolic-ref", "--short", "HEAD") }, before);
  assert.equal(git(r.host, "status", "--porcelain"), "", "the working tree and index as they were");
  assert.equal(fs.existsSync(path.join(r.host, "feature.txt")), false);
  assert.equal(h.placed.length, 1);
  assert.equal(h.placed[0]!.repo, r.host);
  assert.equal(h.placed[0]!.name, "Priya: feature");
  assert.equal(h.placed[0]!.tile.kind, "diff");
  assert.deepEqual((h.placed[0]!.tile as TileRecord & { compare?: unknown }).compare, { base: "main", head: "handoff/priya/feature" });
});

test("a clone whose remote branches the host lacks the start of hands off the branch's whole history", async () => {
  const r = repos();
  // Priya cloned a fork of the host's repository, which has a commit the host has never seen.
  const fork = path.join(r.dir, "fork");
  git(r.dir, "clone", "-q", r.host, fork);
  commit(fork, "fork.txt", "only in the fork\n");
  const guest = path.join(r.dir, "from-fork");
  git(r.dir, "clone", "-q", fork, guest);
  git(guest, "checkout", "-q", "-b", "feature");
  commit(guest, "feature.txt", "from priya\n");
  const h = host(r.host);

  const landed = await h.as(PRIYA, "Priya").handOff(guest);
  assert.equal(landed.branch, "handoff/priya/feature");
  assert.deepEqual(h.sent.map((b) => whole(r.dir, b)), [false, true], "again, whole");
  assert.equal(git(r.host, "rev-parse", "handoff/priya/feature"), git(guest, "rev-parse", "feature"));
  assert.equal(git(r.host, "show", "handoff/priya/feature:fork.txt"), "only in the fork");
});

test("a branch that adds nothing to what the clone tracks goes with its whole history", async () => {
  const r = repos();
  git(r.guest, "checkout", "-q", "-b", "same");
  const h = host(r.host);
  assert.equal((await h.as(PRIYA, "Priya").handOff(r.guest)).branch, "handoff/priya/same");
  assert.equal(git(r.host, "rev-parse", "handoff/priya/same"), git(r.host, "rev-parse", "main"));
  assert.deepEqual(h.sent.map((b) => whole(r.dir, b)), [true]);
});

test("a person lands again over their own hand-off, rewritten or not; never over someone else's of the same name, nor over a branch of the host's own", async () => {
  const r = repos();
  git(r.guest, "checkout", "-q", "-b", "feature");
  commit(r.guest, "feature.txt", "one\n");
  const h = host(r.host);
  const priya = h.as(PRIYA, "Priya");
  await priya.handOff(r.guest);
  // Rewritten: amended, as after a rebase.
  fs.writeFileSync(path.join(r.guest, "feature.txt"), "one, amended\n");
  git(r.guest, "commit", "-q", "-a", "--amend", "-m", "feature, amended");
  await priya.handOff(r.guest);
  const tip = git(r.guest, "rev-parse", "feature");
  assert.equal(git(r.host, "rev-parse", "handoff/priya/feature"), tip);

  // Another Priya, from a clone of their own.
  const other = path.join(r.dir, "other");
  git(r.dir, "clone", "-q", r.host, other);
  git(other, "checkout", "-q", "-b", "feature");
  commit(other, "other.txt", "not priya's\n");
  const refused = await failure(h.as("q".repeat(64), "Priya").handOff(other));
  assert.equal(refused.code, "FAILED");
  assert.match(refused.message, /someone else's hand-off/);
  assert.equal(git(r.host, "rev-parse", "handoff/priya/feature"), tip, "theirs as it was");

  // A branch the host made itself under that name.
  git(r.host, "branch", "handoff/priya/mine");
  git(r.guest, "checkout", "-q", "-b", "mine");
  const own = await failure(priya.handOff(r.guest));
  assert.equal(own.code, "FAILED");
  assert.match(own.message, /a branch of this repository's own/);
  assert.equal(git(r.host, "rev-parse", "handoff/priya/mine"), git(r.host, "rev-parse", "main"));
});

test("the host takes a branch named plainly, a git bundle, of 32 MB at most, and only from someone who may edit the board; and a clone on no branch hands off nothing", async () => {
  const r = repos();
  const h = host(r.host);
  const editor = h.as(PRIYA, "Priya");
  const call = (branch: string, bundle: string) => failure(editor.client.call("git.handOff", workspaceUrl(W), branch, bundle));
  const real = (() => {
    const file = path.join(r.dir, "real.bundle");
    git(r.guest, "bundle", "create", "-q", file, "refs/heads/main");
    return fs.readFileSync(file).toString("base64");
  })();
  for (const name of ["../x", "-x", "a..b", ".hidden", "x.lock", "a//b", "a/", "x y", "x~1"]) {
    assert.equal((await call(name, real)).code, "BAD_REQUEST", name);
  }
  const notBundle = await call("feature", Buffer.from("not a bundle\n").toString("base64"));
  assert.equal(notBundle.code, "BAD_REQUEST");
  assert.match(notBundle.message, /not a git bundle/);
  const tooLarge = await call("feature", "A".repeat(Math.ceil(HAND_OFF_MAX_BYTES / 3) * 4 + 4));
  assert.equal(tooLarge.code, "BAD_REQUEST");
  assert.match(tooLarge.message, /32 MB at most/);
  assert.equal((await failure(h.as("v".repeat(64), "Viewer", "view").client.call("git.handOff", workspaceUrl(W), "feature", real))).code, "FORBIDDEN");
  assert.equal(git(r.host, "branch", "--list", "handoff/*"), "", "nothing landed");
  assert.equal(h.placed.length, 0);

  git(r.guest, "checkout", "-q", "--detach");
  assert.match((await failure(editor.handOff(r.guest))).message, /check out a branch/);
});
