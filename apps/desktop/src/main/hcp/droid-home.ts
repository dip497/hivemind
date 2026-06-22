/**
 * Seed the EPHEMERAL droid FACTORY_HOME_OVERRIDE home. Droid loads hooks from
 * `<FACTORY_HOME>/.factory/hooks.json`, and we point droid at this hivemind-owned
 * home (per install) so we can inject our deterministic-signal hooks WITHOUT
 * touching the user's real ~/.factory.
 *
 * The home must still look complete to droid — auth, settings, sessions, the
 * project transcript store, custom droids/skills — so we SYMLINK every child of
 * the real ~/.factory into `<droidHome>/.factory`, then write our own real
 * `hooks.json` alongside. Reads/writes to sessions, projects, settings flow
 * through the symlinks into the canonical store, so login + resume + transcripts
 * stay shared with the user's normal droid usage; only hooks.json is ours.
 *
 * Idempotent: safe to call on every daemon start. Never deletes the real
 * ~/.factory. Best-effort — a failure just means droid falls back to its normal
 * home (deterministic hooks off; the screen-scrape detector still drives status).
 *
 * Caveat: if droid replaces a symlinked top-level file via atomic write+rename
 * (e.g. settings.json), the new real file lands in the droid-home overlay and the
 * canonical file goes stale until the next re-seed. Acceptable — settings rarely
 * change mid-session, and re-seed restores the link.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdirSync, readdirSync, symlinkSync, lstatSync, readlinkSync, writeFileSync, readFileSync, rmSync,
} from "node:fs";

// Files hivemind OWNS in the overlay (written real, never symlinked to the user's
// real ~/.factory): our hooks, and a local-settings override that disables droid's
// self-updater — its updater chmods a binary under <FACTORY_HOME>/.factory/updates
// which doesn't exist in the ephemeral home (harmless ENOENT noise), and we don't
// want droid swapping its own binary out from under a running tile anyway.
const OWNED = new Set(["hooks.json", "settings.local.json"]);

export interface SeedDroidHomeOpts {
  /** The FACTORY_HOME_OVERRIDE target dir (its `.factory/` is populated). */
  droidHome: string;
  /** The hooks.json contents (from droidHooksSettings). */
  hooks: unknown;
  /** Override the real factory dir (tests). Default ~/.factory. */
  realFactory?: string;
}

/** Symlink every child of the real ~/.factory into <droidHome>/.factory, then
 *  write our hooks.json. Returns the FACTORY_HOME_OVERRIDE value to export. */
export function seedDroidHome(opts: SeedDroidHomeOpts): string {
  const real = opts.realFactory ?? join(homedir(), ".factory");
  const dotFactory = join(opts.droidHome, ".factory");
  mkdirSync(dotFactory, { recursive: true });

  let children: import("node:fs").Dirent[] = [];
  try { children = readdirSync(real, { withFileTypes: true }); }
  catch { /* no real ~/.factory yet (fresh droid install) — just write hooks */ }

  for (const c of children) {
    if (OWNED.has(c.name)) continue; // hivemind owns these (written below)
    const link = join(dotFactory, c.name);
    const target = join(real, c.name);
    try {
      // Already the right symlink? leave it. Wrong/stale link? replace it. A real
      // file/dir that droid wrote into the overlay? leave it (don't clobber).
      const st = lstatSync(link);
      if (st.isSymbolicLink()) {
        if (readlinkSync(link) === target) continue;
        rmSync(link, { force: true });
      } else {
        continue;
      }
    } catch { /* not present → create below */ }
    try { symlinkSync(target, link); } catch { /* best-effort */ }
  }

  try { writeFileSync(join(dotFactory, "hooks.json"), JSON.stringify(opts.hooks, null, 2)); }
  catch { /* best-effort */ }

  // settings.local.json (merges on top of the user's symlinked settings.json):
  // carry over the user's real local overrides if any, then force disableAutoUpdate.
  let local: Record<string, unknown> = {};
  try { local = JSON.parse(readFileSync(join(real, "settings.local.json"), "utf8")); }
  catch { /* none → start fresh */ }
  local.disableAutoUpdate = true;
  try { writeFileSync(join(dotFactory, "settings.local.json"), JSON.stringify(local, null, 2)); }
  catch { /* best-effort */ }
  return opts.droidHome;
}
