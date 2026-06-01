// Unit tests for the per-tile live-session store — the fix for multi-frame
// resume. The OLD tracker did an unsynchronized read-modify-write on ONE shared
// `tile-sessions.json` through a single fixed `.tmp`; when several claude tiles
// (multiple frames) fired their SessionStart hooks at once on restart, writers
// lost each other's updates and a tile's tracked session id vanished. The
// per-tile-file scheme has no shared state, so concurrent writers can't clobber.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  evictTrackedSession,
  readTrackedSession,
  tileSessionFile,
  trackerSource,
  writeTrackedSession,
} from "../../src/main/tile-session-store.ts";

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), "hm-tss-"));
}

test("write then read round-trips a tile's session id", () => {
  const dir = freshDir();
  try {
    writeTrackedSession(dir, "tile-claude-1", "sess-AAA");
    assert.equal(readTrackedSession(dir, "tile-claude-1"), "sess-AAA");
    // unknown tile → undefined
    assert.equal(readTrackedSession(dir, "tile-claude-NOPE"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each tile has an INDEPENDENT file — no cross-tile clobber", () => {
  const dir = freshDir();
  try {
    for (let i = 0; i < 12; i++) writeTrackedSession(dir, `tile-${i}`, `sess-${i}`);
    for (let i = 0; i < 12; i++) assert.equal(readTrackedSession(dir, `tile-${i}`), `sess-${i}`);
    // re-write one tile → overwrites only its own value
    writeTrackedSession(dir, "tile-3", "sess-3b");
    assert.equal(readTrackedSession(dir, "tile-3"), "sess-3b");
    assert.equal(readTrackedSession(dir, "tile-4"), "sess-4");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evict removes a tile's tracked file", () => {
  const dir = freshDir();
  try {
    writeTrackedSession(dir, "tile-x", "sess-x");
    assert.equal(readTrackedSession(dir, "tile-x"), "sess-x");
    evictTrackedSession(dir, "tile-x");
    assert.equal(readTrackedSession(dir, "tile-x"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("falls back to the legacy shared map when no per-tile file exists", () => {
  const dir = freshDir();
  try {
    const legacy = path.join(dir, "tile-sessions.json");
    writeFileSync(legacy, JSON.stringify({ "tile-old": "sess-legacy" }));
    // per-tile file wins when present…
    writeTrackedSession(dir, "tile-new", "sess-new");
    assert.equal(readTrackedSession(dir, "tile-new", legacy), "sess-new");
    // …legacy map used only when the per-tile file is absent
    assert.equal(readTrackedSession(dir, "tile-old", legacy), "sess-legacy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CONCURRENT trackers (multiple frames on restart) all persist — no lost updates", async () => {
  const dir = freshDir();
  const trackerPath = path.join(dir, "tracker.cjs");
  writeFileSync(trackerPath, trackerSource());
  const N = 16;
  try {
    // Spawn N tracker processes AT ONCE, each for a different tile, each fed the
    // SessionStart hook JSON on stdin. This reproduces every frame's claude tile
    // firing its hook simultaneously on app restart.
    await Promise.all(
      Array.from({ length: N }, (_unused, i) => {
        return new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, [trackerPath, dir], {
            env: { ...process.env, HIVEMIND_TILE: `tile-${i}` },
            stdio: ["pipe", "ignore", "ignore"],
          });
          child.on("error", reject);
          child.on("exit", () => resolve());
          child.stdin.end(JSON.stringify({ session_id: `sess-${i}` }));
        });
      }),
    );
    // EVERY tile's id must have survived — the old shared-map design lost some.
    for (let i = 0; i < N; i++) {
      assert.equal(
        readTrackedSession(dir, `tile-${i}`),
        `sess-${i}`,
        `tile-${i} lost its tracked session id under concurrency`,
      );
    }
    // No stray tmp files left behind.
    const leftoverTmp = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftoverTmp, [], "tracker left .tmp files behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tracker no-ops when session_id is absent or value unchanged", () => {
  const dir = freshDir();
  const trackerPath = path.join(dir, "tracker.cjs");
  writeFileSync(trackerPath, trackerSource());
  try {
    // no session_id in payload → nothing written
    spawnSync(process.execPath, [trackerPath, dir], {
      env: { ...process.env, HIVEMIND_TILE: "tile-z" },
      input: JSON.stringify({ source: "startup" }),
    });
    assert.equal(readTrackedSession(dir, "tile-z"), undefined);
    assert.ok(!readdirSync(dir).some((f) => f === path.basename(tileSessionFile(dir, "tile-z"))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
