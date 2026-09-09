/**
 * Renderer settings store: writes are dotted-path patches, and a broadcast from
 * another writer (the CLI's `settings.reload`, a second window) must not yank
 * back an edit the user just made and we have not persisted yet.
 *
 * The store binds `window.hive` at import time, so the fake bridge is installed
 * before the dynamic import.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, applyPreset, mergeSettings, PRESETS, setPath, type Settings } from "@hivemind/core/settings-schema";

type Patch = { path: string; value: unknown };

const sent: Patch[][] = [];
let broadcast: ((s: Settings) => void) | null = null;
let file: Settings = mergeSettings(DEFAULT_SETTINGS);
const inflight: ((s: Settings) => void)[] = [];
let failNext = false;


(globalThis as unknown as { window: unknown }).window = {
  addEventListener() {},
  removeEventListener() {},
  localStorage: { getItem: () => null },
  hive: {
    settingsSync: () => file,
    settingsPatch: (patches: Patch[]) => {
      sent.push(patches);
      if (failNext) { failNext = false; return Promise.reject(new Error("EACCES: settings.json is not writable")); }
      // Resolve when the test says so, applying the patches like main would.
      return new Promise<Settings>((res) => {
        inflight.push(res);
      });
    },
    onSettingsChanged: (cb: (s: Settings) => void) => { broadcast = cb; return () => {}; },
  },
};

const store = await import("../../src/renderer/src/settings-store");

/** Resolve every write the store has open (each reply applies the store's own
 *  current state, like main would), until it stops starting follow-ups. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10 && inflight.length; i++) {
    const res = inflight.shift()!;
    res(mergeSettings(store.getSettings()));
    await new Promise((r) => setTimeout(r, 0));
  }
}

test("an edit applies immediately and is recorded as a pending path patch", () => {
  store.patchSettings("appearance.glass.blur", 20);
  assert.equal(store.getSettings().appearance.glass.blur, 20);
  assert.deepEqual(store.pendingPatches(), { "appearance.glass.blur": 20 });
});

test("a broadcast from another writer keeps our un-persisted edit on screen", () => {
  // The CLI wrote a preset while the user is dragging the blur slider.
  const fromCli = mergeSettings({ ...file, appearance: applyPreset(file.appearance, PRESETS.nord!) });
  broadcast!(fromCli);
  const s = store.getSettings();
  assert.equal(s.appearance.preset, "nord", "the other writer's change is adopted");
  assert.equal(s.appearance.glass.blur, 20, "our pending edit is NOT reverted");
});

test("the flush sends only the pending paths, and clears them when the write lands", async () => {
  store.flushSettings();
  assert.deepEqual(sent.at(-1), [{ path: "appearance.glass.blur", value: 20 }]);
  // Main applies the patch to the file and answers with what it wrote.
  const written = mergeSettings(setPath(mergeSettings({ ...file, appearance: applyPreset(file.appearance, PRESETS.nord!) }), "appearance.glass.blur", 20));
  inflight.shift()!(written);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(store.pendingPatches(), {}, "confirmed patches stop being pending");
  assert.equal(store.getSettings().appearance.glass.blur, 20);
  assert.equal(store.getSettings().appearance.preset, "nord");
});

test("an edit made while a write is in flight stays pending (and stays on screen)", async () => {
  store.patchSettings("agents.model", "opus");
  store.flushSettings();
  store.patchSettings("agents.model", "sonnet"); // newer value, same path
  const written = mergeSettings(setPath(store.getSettings(), "agents.model", "opus"));
  inflight.shift()!(written);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(store.pendingPatches(), { "agents.model": "sonnet" }, "the newer edit is not dropped");
  assert.equal(store.getSettings().agents.model, "sonnet");
  await settle(); // let the store's follow-up write finish before the next test
  assert.deepEqual(store.pendingPatches(), {});
});

test("flushes are serialized: a second flush waits for the write in flight", async () => {
  const before = sent.length;
  store.patchSettings("views.defaultView", "world");
  store.flushSettings();
  assert.equal(sent.length, before + 1, "one write started");
  // More edits + another flush while the first write is still open.
  store.patchSettings("agents.permissionMode", "plan");
  store.flushSettings();
  store.flushSettings();
  assert.equal(sent.length, before + 1, "no overlapping write was started");

  // Finish the first write; the queued edits go out as ONE follow-up write.
  inflight.shift()!(mergeSettings(setPath(store.getSettings(), "views.defaultView", "world")));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sent.length, before + 2, "the deferred flush ran once, after");
  assert.deepEqual(sent.at(-1), [{ path: "agents.permissionMode", value: "plan" }]);
  inflight.shift()!(mergeSettings(setPath(store.getSettings(), "agents.permissionMode", "plan")));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(store.pendingPatches(), {});
});

test("ABA: a path edited back to its old value while a write is in flight stays pending", async () => {
  store.patchSettings("agents.model", "opus");   // A (this is what gets sent)
  store.flushSettings();
  store.patchSettings("agents.model", "sonnet"); // B
  store.patchSettings("agents.model", "opus");   // back to A — same VALUE, newer edit
  const written = mergeSettings(setPath(store.getSettings(), "agents.model", "opus"));
  inflight.shift()!(written);
  await new Promise((r) => setTimeout(r, 0));
  // Comparing values would have retired it here and dropped a real edit.
  assert.deepEqual(store.pendingPatches(), { "agents.model": "opus" }, "the newer edit is still pending");
  assert.equal(sent.at(-1)?.length, 1);
  await settle(); // the follow-up flush the store started
  assert.deepEqual(store.pendingPatches(), {});
});

test("a save failure is reported once per streak, and speaks again after a success", async () => {
  await settle();
  const before = store.saveErrorReports();
  failNext = true;
  store.patchSettings("agents.model", "haiku");
  store.flushSettings();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(store.saveErrorReports(), before + 1, "the first failure is reported");

  failNext = true;
  store.patchSettings("agents.model", "opus");
  store.flushSettings();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(store.saveErrorReports(), before + 1, "a second failure in the same streak is silent");

  // A successful save re-arms the report for a later, separate failure.
  store.flushSettings();
  await settle();
  assert.deepEqual(store.pendingPatches(), {});
  failNext = true;
  store.patchSettings("agents.model", "sonnet");
  store.flushSettings();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(store.saveErrorReports(), before + 2, "a failure after a good save is reported again");
  store.flushSettings();
  await settle();
  assert.deepEqual(store.pendingPatches(), {});
});

test("a rejected write keeps its edits pending and does NOT retry in a loop", async () => {
  await settle();
  const before = sent.length;
  failNext = true;
  store.patchSettings("appearance.radius", 4);
  store.flushSettings();
  assert.equal(sent.length, before + 1, "one attempt was made");
  // Several ticks: a `finally`-driven retry would have sent it again by now.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(sent.length, before + 1, "no automatic retry after a failed write");
  assert.deepEqual(store.pendingPatches(), { "appearance.radius": 4 }, "the edit is kept, not lost");
  assert.equal(store.getSettings().appearance.radius, 4, "and stays on screen");

  // The user's next edit carries it out — no data lost, no hot loop.
  store.patchSettings("appearance.radius", 6);
  store.flushSettings();
  assert.equal(sent.length, before + 2);
  assert.deepEqual(sent.at(-1), [{ path: "appearance.radius", value: 6 }]);
  await settle();
  assert.deepEqual(store.pendingPatches(), {});
});

test("patches are applied and sent in EDIT order, so a newer parent is not undone by an older child", async () => {
  await settle();
  const before = sent.length;
  // Parent first (it takes a slot in the Map), then a child, then the parent
  // again: re-setting a Map key keeps its ORIGINAL slot, so insertion order
  // would replay the child last and resurrect the value the parent replaced.
  store.patchSettings("appearance", { ...store.getSettings().appearance, radius: 10 });
  store.patchSettings("appearance.radius", 12);
  store.patchSettings("appearance", { ...store.getSettings().appearance, radius: 14 });
  assert.equal(store.getSettings().appearance.radius, 14, "the newest edit wins locally");
  store.flushSettings();
  const paths = sent.at(-1)!.map((p) => p.path);
  assert.deepEqual(paths, ["appearance.radius", "appearance"], "sent oldest-revision first");
  await settle();
  assert.equal(store.getSettings().appearance.radius, 14);
});

test("an edit made during a write is sent automatically when that write succeeds — no manual flush", async () => {
  await settle();
  const before = sent.length;
  store.patchSettings("views.defaultView", "windows");
  store.flushSettings();                       // the only explicit flush: starts write #1
  assert.equal(sent.length, before + 1);
  store.patchSettings("agents.permissionMode", "acceptEdits"); // arrives mid-write, NOT flushed
  assert.equal(sent.length, before + 1, "no overlapping write");

  // Completing write #1 must chain write #2 by itself. If the chain ran before
  // `inFlight` was cleared it would silently drop, and this edit would sit
  // pending until the user happened to change something else.
  inflight.shift()!(mergeSettings(setPath(store.getSettings(), "views.defaultView", "windows")));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sent.length, before + 2, "the follow-up write was chained automatically");
  assert.deepEqual(sent.at(-1), [{ path: "agents.permissionMode", value: "acceptEdits" }]);
  await settle();
  assert.deepEqual(store.pendingPatches(), {});
});
