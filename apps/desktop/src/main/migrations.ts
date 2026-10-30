/**
 * The app moves this machine's data forward (`@hivemind/core/migrations`) before it opens a window.
 * What it did, and what failed, is said once on stderr and once in the first window; the app
 * starts on the data as it is either way. Settings read before (a module that reads them as it
 * loads) are read again once a migration ran, so main never holds them as they were.
 */
import { app } from "electron";
import { runMigrations } from "@hivemind/core/migrations";
import { recordRunningApp } from "@hivemind/core/migrations/manage";
import { reloadSettings } from "./settings-store.js";

const notices: string[] = [];

export async function migrateOnStart(): Promise<void> {
  const say = (line: string) => { console.warn(`[migrations] ${line}`); notices.push(line); };
  let ran = 0;
  try {
    for (const r of await runMigrations({ by: "app", app: app.getVersion(), roots: { data: app.getPath("userData") }, say })) {
      for (const a of r.applied) console.log(`[migrations] ${a.id} ran in ${a.ms} ms: ${JSON.stringify(a.result)}`);
      ran += r.applied.length;
    }
  } catch (e) {
    say(e instanceof Error ? e.message : String(e));
  }
  if (ran) await reloadSettings().catch((e: unknown) => console.warn("[migrations] could not read the settings again:", e));
  await recordRunningApp(app.getPath("userData"), app.getVersion()).catch((e: unknown) => console.warn("[migrations] could not record this app's version:", e));
}

/** The lines for the person, once: the first window to load takes them. */
export function takeMigrationNotices(): string[] {
  return notices.splice(0);
}
