/**
 * settings-store (renderer) — the live mirror of main's settings.json.
 *
 * Boot: ONE synchronous IPC read so the first paint already has the theme
 * (no flash), and a one-time import of the pre-2.0 localStorage keys into the
 * file (main marks `migrated`). Every change — ours, the CLI's via
 * `settings.reload`, another window's — arrives back on `settings:changed`.
 * Falls back to an in-memory store outside Electron (unit tests, the dev bridge).
 *
 * WRITES ARE PATHS, NOT SNAPSHOTS. A slider drag used to send the whole settings
 * object 150 ms later, so anything written meanwhile (a `hive theme use`, another
 * window) was silently reverted by a snapshot taken before it. Now an edit
 * records a dotted-path patch, the debounce sends the pending patches, and main
 * applies them to the file inside a lock. The optimistic value stays on screen
 * until the write that carries it resolves: an incoming broadcast is merged as
 * "what the file says, plus the patches we have not persisted yet", so a
 * broadcast never yanks the control the user is dragging.
 */
import { useSyncExternalStore } from "react";
import { DEFAULT_SETTINGS, mergeSettings, setPath, type Settings } from "@hivemind/core/settings-schema";

const hive = typeof window !== "undefined" ? (window as Window & { hive?: typeof window.hive }).hive : undefined;

function boot(): Settings {
  try { if (hive?.settingsSync) return mergeSettings(hive.settingsSync()); } catch { /* no bridge */ }
  return mergeSettings(DEFAULT_SETTINGS);
}

let state: Settings = boot();
const listeners = new Set<() => void>();
function emit() { for (const l of listeners) l(); }

// One-time migration of what the renderer used to keep in localStorage. The
// keys are left in place (harmless; a downgrade still reads them).
if (typeof window !== "undefined" && hive?.settingsMigrate && !state.migrated) {
  const ls = (k: string) => { try { return window.localStorage.getItem(k); } catch { return null; } };
  let theme: unknown;
  try { theme = JSON.parse(ls("hivemind:theme") ?? "null"); } catch { theme = null; }
  void hive.settingsMigrate({
    theme, viewMode: ls("hivemind:view-mode"), agentSel: ls("hivemind:agent-sel"), claudeMode: ls("hivemind:claude-mode"), claudeModel: ls("hivemind:claude-model"),
    // An edit made while the migration was in flight must survive its reply.
  }).then((s) => { state = withPending(mergeSettings(s)); emit(); }).catch(() => {});
}

// Patches applied locally but not yet confirmed by main: newest value per path,
// each tagged with the revision of the edit that produced it. The revision — not
// the value — decides whether a confirmation retires the entry: an edit that goes
// A → B → A while a write is in flight would compare equal by value and drop a
// patch that still needs persisting (ABA).
interface Pending { value: unknown; rev: number }
const pending = new Map<string, Pending>();
let revSeq = 0;

/** Pending edits oldest-first BY REVISION. Map iteration is insertion order, and
 *  re-setting an existing key keeps its original slot — so editing `appearance`,
 *  then `appearance.glass.blur`, then `appearance` again would replay the child
 *  after the newer parent and resurrect the value the parent replaced. */
function pendingByRev(): [string, Pending][] {
  return [...pending].sort((a, b) => a[1].rev - b[1].rev);
}

/** The file's settings + our not-yet-persisted edits, applied in edit order. */
function withPending(base: Settings): Settings {
  let next = base;
  for (const [dotted, p] of pendingByRev()) next = setPath(next, dotted, p.value);
  return mergeSettings(next, base);
}

if (hive?.onSettingsChanged) hive.onSettingsChanged((s) => { state = withPending(mergeSettings(s)); emit(); });

export function getSettings(): Settings { return state; }
export function subscribeSettings(l: () => void): () => void { listeners.add(l); return () => { listeners.delete(l); }; }
export function useSettings(): Settings { return useSyncExternalStore(subscribeSettings, getSettings, getSettings); }

// Debounced persistence: a drag is many patches, one write.
let timer: ReturnType<typeof setTimeout> | null = null;
function persist(delayMs = 150) {
  if (!hive?.settingsPatch || pending.size === 0) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, delayMs);
}

// A save failure is reported ONCE per failing streak: a rejected write usually
// means a condition that will reject the next one too (a read-only file, a lock
// held by another writer), and one toast per keystroke would be its own bug.
// Cleared by the next successful write, so a later failure speaks again.
// sonner is imported lazily: this module is also loaded outside the app (unit
// tests, the dev bridge), where a UI dependency has no business being pulled in.
let saveErrorShown = false;
let saveErrorReportCount = 0;
function reportSaveFailure(): void {
  if (saveErrorShown) return;
  saveErrorShown = true;
  saveErrorReportCount++;
  void import("sonner")
    .then(({ toast }) => toast.error("Could not save settings. Changes are pending.", {
      action: { label: "Retry", onClick: flushSettings },
    }))
    .catch(() => { /* no UI here (tests, dev bridge) — the pending edit still stands */ });
}

// One write at a time. Two overlapping `settings:patch` calls would be applied
// to the file in whatever order main happened to finish them, and each reply
// would rebase local state on a different snapshot. Edits made while a write is
// open simply stay in `pending`; the successful write chains a follow-up for
// them, so no separate "more arrived" flag is needed.
let inFlight: Promise<void> | null = null;

function flush(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!hive?.settingsPatch || pending.size === 0) return;
  // A write is open: this edit is already recorded in `pending`, and the
  // successful write chains a follow-up for whatever is still pending — so
  // there is nothing to remember here.
  if (inFlight) return;
  const sent = pendingByRev().map(([path, p]) => ({ path, value: p.value, rev: p.rev }));
  inFlight = (async () => {
    let ok = false;
    try {
      const written = await hive.settingsPatch!(sent.map(({ path, value }) => ({ path, value })));
      // Retire only the exact edits this write carried. A path edited again
      // while it was in flight has a newer revision and stays pending —
      // including when the new value happens to equal the old one.
      for (const { path, rev } of sent) if (pending.get(path)?.rev === rev) pending.delete(path);
      state = withPending(mergeSettings(written));
      emit();
      ok = true;
      saveErrorShown = false; // a save worked: a later failure is news again
    } catch {
      // Keep the patches pending and STOP. Chaining here would spin: a rejected
      // write (no permission, disk full, a lock we could not take) leaves its
      // paths pending, so an unconditional retry sends them again immediately,
      // forever. They go out with the user's next edit or an explicit flush.
      reportSaveFailure();
    } finally {
      inFlight = null;
    }
    // Only a SUCCESSFUL write chains the next one, and only after `finally`
    // above has cleared `inFlight` — otherwise the chained flush would see a
    // write still in progress and drop itself.
    if (ok && pending.size > 0) flush();
  })();
}

if (typeof window !== "undefined") window.addEventListener("beforeunload", flush);

/** Set one dotted path (`appearance.glass.blur`), apply now, persist soon. */
export function patchSettings(dotted: string, value: unknown): void {
  patchSettingsMany([{ path: dotted, value }]);
}

/** Several dotted paths as one edit (a preset changes palette + terminal +
 *  accent together). Only the paths given are written — everything else in the
 *  file is left to whoever owns it. */
export function patchSettingsMany(patches: readonly { path: string; value: unknown }[]): void {
  if (patches.length === 0) return;
  let next = state;
  for (const { path, value } of patches) { pending.set(path, { value, rev: ++revSeq }); next = setPath(next, path, value); }
  state = mergeSettings(next, state);
  emit();
  persist();
}

/** Replace whole sections (a theme import). Each section is one path patch, so
 *  sections nobody touched here are never rewritten. */
export function replaceSettings(next: Partial<Settings>): void {
  patchSettingsMany(Object.entries(next).map(([k, value]) => ({ path: k, value })));
}

/** Test seam: how many times a save failure was reported (one per streak). */
export function saveErrorReports(): number { return saveErrorReportCount; }

/** Test seam: pending patches + a synchronous flush. */
export function pendingPatches(): Record<string, unknown> {
  return Object.fromEntries([...pending].map(([path, p]) => [path, p.value]));
}
export function flushSettings(): void { flush(); }
