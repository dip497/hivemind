/**
 * settings.json, main-process side: the one owner while the app runs. Loads
 * from <userData>/settings.json (the same dir as hcp.token; HIVE_SETTINGS
 * overrides for dev profiles), validates through the shared schema, writes
 * atomically, and broadcasts every change to the renderer (`settings:changed`).
 * The renderer reads the initial value synchronously at boot (no theme flash)
 * and patches through IPC; the CLI edits the file and calls `settings.reload`
 * over HCP.
 */
import { ipcMain } from "electron";
import { readFileSync } from "node:fs";
import { mergeSettings, type Settings } from "@hivemind/core/settings-schema";
import { patchSettingsFile, readSettings, settingsPath, updateSettings } from "@hivemind/core/settings";
import { createSettingsCoordinator } from "./settings-coordinator.js";

let current: Settings | null = null;
let file = "";
const listeners = new Set<(s: Settings) => void>();

// One path for the app AND the `hive` CLI: $HIVE_SETTINGS, else
// $XDG_CONFIG_HOME/hivemind/settings.json (settingsPath()). For a packaged app
// that IS <userData>; in a dev run userData is the separate hivemind-dev
// profile, and configuration is deliberately shared with the CLI anyway — the
// dev profile isolates the canvas, not the user's theme.
export function settingsFile(): string {
  if (!file) file = settingsPath();
  return file;
}

/** Synchronous first load (main is ready before the window; the renderer's
 *  sync IPC needs a value immediately). */
export function getSettings(): Settings {
  if (!current) {
    try { current = mergeSettings(JSON.parse(readFileSync(settingsFile(), "utf8"))); }
    catch { current = mergeSettings({}); }
  }
  return current;
}

function publish(next: Settings) {
  current = next;
  for (const l of listeners) l(next);
}

// Reads and writes are serialized (settings-coordinator.ts): each operation's
// read AND its publish happen inside one critical section, so a reload can
// never publish a snapshot older than one already broadcast, and a fresh read
// is never discarded as "stale" because a slower one published first.
const coordinator = createSettingsCoordinator<Settings>({
  read: () => readSettings(settingsFile()),
  publish,
});

export function onSettingsChange(l: (s: Settings) => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** Replace the whole object (a theme import). Still a locked read/modify/write
 *  so unknown keys and a concurrent writer's file are respected; the caller's
 *  object wins for the fields it carries. */
export async function replaceSettings(next: unknown): Promise<Settings> {
  return coordinator.mutate(() => updateSettings((cur) => mergeSettings(next, cur), settingsFile()));
}

/** Apply dotted-path patches (`appearance.glass.blur`) to the file as it is on
 *  disk — NEVER to main's in-memory snapshot, which may predate a `hive theme
 *  use` from a second ago. This is the path every UI edit takes. */
export async function patchSettings(patches: readonly { path: string; value: unknown }[]): Promise<Settings> {
  return coordinator.mutate(() => patchSettingsFile(patches, settingsFile()));
}

/** One dotted path — the single-patch form of `patchSettings`. */
export async function patchSettingsPath(dotted: string, value: unknown): Promise<Settings> {
  return patchSettings([{ path: dotted, value }]);
}

/** Settings reads or writes still running. */
export function settingsBusy(): boolean {
  return coordinator.depth() > 0;
}

/**
 * Settles once no settings read or write is running, or after `capMs`. The app waits for it
 * before exiting: a write cut off by the exit loses the change it carried, and can leave
 * settings.json's lock behind. The cap keeps a stuck writer from holding the quit.
 */
export async function settingsSettled(capMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<true>((r) => { timer = setTimeout(() => r(true), capMs); });
  try {
    // Operations queued while waiting (the window's last edit, sent as it closed) are waited for too.
    while (settingsBusy()) {
      if (await Promise.race([coordinator.idle().then(() => false as const), capped])) return;
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Re-read the file (edited by the CLI) and broadcast. Queued behind any write
 *  or reload already in flight, so the value main ends up holding is the one
 *  read last, not the one that happened to finish first. */
export async function reloadSettings(): Promise<Settings> {
  return coordinator.reload();
}

/** Validate the renderer's patch list: dotted paths + JSON values only. */
function sanitizePatches(raw: unknown): { path: string; value: unknown }[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p) => {
    if (!p || typeof p !== "object") return [];
    const dotted = (p as { path?: unknown }).path;
    if (typeof dotted !== "string" || !dotted) return [];
    return [{ path: dotted, value: (p as { value?: unknown }).value }];
  }).slice(0, 200);
}

/** IPC surface + change broadcast to the window. */
export function installSettingsIpc(tellWindows: (channel: string, settings: Settings) => void): void {
  ipcMain.on("settings:get-sync", (e) => { e.returnValue = getSettings(); });
  ipcMain.handle("settings:get", () => getSettings());
  ipcMain.handle("settings:replace", (_e, next: unknown) => replaceSettings(next));
  ipcMain.handle("settings:set", (_e, dotted: unknown, value: unknown) => patchSettingsPath(String(dotted), value));
  // Batched dotted-path patches — what the renderer sends now (a full-object
  // replace from a debounced UI would revert whatever else was written meanwhile).
  ipcMain.handle("settings:patch", (_e, patches: unknown) => patchSettings(sanitizePatches(patches)));
  ipcMain.handle("settings:path", () => settingsFile());
  onSettingsChange((s) => tellWindows("settings:changed", s));
}
