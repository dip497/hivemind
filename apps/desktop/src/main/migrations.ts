/**
 * The app moves this machine's data forward (`@hivemind/core/migrations`) before it loads its
 * settings or opens a window. What it did, and what failed, is said once on stderr and once in the
 * first window; the app starts on the data as it is either way.
 */
import { app } from "electron";
import { runMigrations } from "@hivemind/core/migrations";

const notices: string[] = [];

export async function migrateOnStart(): Promise<void> {
  const say = (line: string) => { console.warn(`[migrations] ${line}`); notices.push(line); };
  try {
    for (const r of await runMigrations({ by: "app", app: app.getVersion(), roots: { data: app.getPath("userData") }, say })) {
      for (const a of r.applied) console.log(`[migrations] ${a.id} ran in ${a.ms} ms: ${JSON.stringify(a.result)}`);
    }
  } catch (e) {
    say(e instanceof Error ? e.message : String(e));
  }
}

/** The lines for the person, once: the first window to load takes them. */
export function takeMigrationNotices(): string[] {
  return notices.splice(0);
}
