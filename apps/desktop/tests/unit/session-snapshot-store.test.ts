import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TOKEN_PLACEHOLDER, fileNameForId, idFromFileName, listSnapshotFiles, readSnapshot,
  redactSnapshot, rehydrateSnapshot, secureDir, staleSnapshotIds, SNAPSHOT_RETENTION_MS,
} from "../../src/main/session-snapshot-store.ts";
import type { SessionSnapshot } from "../../src/main/pty-session-manager.ts";

const posix = process.platform !== "win32";
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "hm-snap-"));
const snap = (env?: Record<string, string>): SessionSnapshot => ({
  id: "hm:tile-claude-1",
  spec: { cwd: "/w", cmd: "claude", args: ["--session-id", "u"], cols: 80, rows: 24, ...(env ? { env } : {}) },
  replay: "[1mhello[0m",
  savedAt: 1,
});

test("the token never reaches disk, and the current one comes back on restore", () => {
  const live = snap({ HCP_TOKEN: "secret-live-token", HIVEMIND_TILE: "t1" });
  const written = redactSnapshot(live);
  assert.equal(written.spec.env!.HCP_TOKEN, TOKEN_PLACEHOLDER);
  assert.ok(!JSON.stringify(written).includes("secret-live-token"), "no copy of the token anywhere in the file body");
  assert.equal(written.spec.env!.HIVEMIND_TILE, "t1", "other variables are untouched");
  assert.equal(live.spec.env!.HCP_TOKEN, "secret-live-token", "the live spec is not mutated");

  const restored = rehydrateSnapshot(written, "token-of-this-boot");
  assert.equal(restored.spec.env!.HCP_TOKEN, "token-of-this-boot");
});

test("a snapshot from before this rule restores with today's token, not its stale one", () => {
  const legacy = snap({ HCP_TOKEN: "token-from-last-month" });
  assert.equal(rehydrateSnapshot(legacy, "token-now").spec.env!.HCP_TOKEN, "token-now");
});

test("with no token available the variable is dropped, never sent as a placeholder", () => {
  const restored = rehydrateSnapshot(redactSnapshot(snap({ HCP_TOKEN: "x" })), undefined);
  assert.ok(!("HCP_TOKEN" in restored.spec.env!));
});

test("specs without the token are passed through untouched", () => {
  const plain = snap({ TERM: "xterm-256color" });
  assert.equal(redactSnapshot(plain), plain);
  assert.equal(rehydrateSnapshot(plain, "t"), plain);
  const noEnv = snap();
  assert.equal(redactSnapshot(noEnv), noEnv);
});

test("ids round-trip through file names, and junk file names are not snapshots", () => {
  for (const id of ["hm:tile-claude-1", "hm:a:b:c", "weird id/with\\slashes"]) {
    assert.equal(idFromFileName(fileNameForId(id)), id);
  }
  assert.equal(idFromFileName("notes.txt"), null);
  assert.equal(idFromFileName(".json"), null);
  assert.equal(idFromFileName("x.json.tmp"), null);
  assert.equal(idFromFileName("!!not base64!!.json"), null);
});

test("listing registers every snapshot WITHOUT reading its contents", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, fileNameForId("hm:ok")), JSON.stringify(snap()));
  // unparseable on purpose: a listing that parsed would drop or throw on it
  fs.writeFileSync(path.join(dir, fileNameForId("hm:corrupt")), "{ not json");
  fs.writeFileSync(path.join(dir, "unrelated.txt"), "x");
  const ids = listSnapshotFiles(dir).map((e) => e.id).sort();
  assert.deepEqual(ids, ["hm:corrupt", "hm:ok"]);
});

test("reading is where a bad file is caught, and only for that one tile", () => {
  const dir = tmp();
  const good = path.join(dir, fileNameForId("hm:tile-claude-1"));
  fs.writeFileSync(good, JSON.stringify(snap()));
  const bad = path.join(dir, fileNameForId("hm:corrupt"));
  fs.writeFileSync(bad, "{ not json");
  assert.equal(readSnapshot(good, "hm:tile-claude-1")?.replay, snap().replay);
  assert.equal(readSnapshot(bad), undefined);
  assert.equal(readSnapshot(good, "hm:someone-else"), undefined, "a file must not restore under another id");
  assert.equal(readSnapshot(path.join(dir, "missing.json")), undefined);
});

test("the directory is 0700 and files are tightened to 0600", { skip: !posix }, () => {
  const dir = path.join(tmp(), "sessions");
  fs.mkdirSync(dir, { mode: 0o775 });
  secureDir(dir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const f = path.join(dir, fileNameForId("hm:loose"));
  fs.writeFileSync(f, JSON.stringify(snap()), { mode: 0o664 });
  fs.chmodSync(f, 0o664); // defeat the umask so the file really starts loose
  listSnapshotFiles(dir);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600, "a snapshot written before this rule is repaired");
});

test("retention evicts only snapshots that are BOTH unclaimed and old", () => {
  const now = 1_000_000_000_000;
  const old = now - SNAPSHOT_RETENTION_MS - 1;
  const fresh = now - 1000;
  const entries = [
    { id: "gone-old", file: "a", mtimeMs: old },      // closed long ago → evict
    { id: "gone-fresh", file: "b", mtimeMs: fresh },  // closed recently → keep a while
    { id: "open-old", file: "c", mtimeMs: old },      // attached this boot → keep
  ];
  assert.deepEqual(staleSnapshotIds(entries, ["gone-old", "gone-fresh"], now), ["gone-old"]);
});

test("retention never evicts a snapshot some tile claimed, however old", () => {
  const now = 1_000_000_000_000;
  const entries = [{ id: "t", file: "x", mtimeMs: 0 }];
  assert.deepEqual(staleSnapshotIds(entries, [], now), []);
});
