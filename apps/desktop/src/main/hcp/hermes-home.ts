/**
 * Seed the EPHEMERAL HERMES_HOME overlay. Hermes resolves EVERYTHING from
 * HERMES_HOME (config.yaml, .env, auth.json, state.db, sessions/) — same shape
 * as droid's FACTORY_HOME_OVERRIDE. We point a spawned hermes tile at this
 * hivemind-owned home (per install) so we can inject our deterministic-signal
 * hooks WITHOUT touching the user's real ~/.hermes.
 *
 * The overlay symlinks every child of the real ~/.hermes (auth, skills, state
 * db, sessions, .env …) so login + session resume + memory stay shared with the
 * user's normal hermes usage. config.yaml is the one file hivemind OWNS: the
 * user's real config is parsed, our `hooks:` events are MERGED into theirs
 * (theirs win on key conflicts so a user hook is never dropped), and the merged
 * result is written real into the overlay. Hermes's own hooks merge semantics
 * are list-append per event, so both sets fire.
 *
 * Idempotent: safe to call on every daemon start. Never deletes the real
 * ~/.hermes. Best-effort — a failure just means hermes falls back to its normal
 * home (deterministic hooks off; the screen-scrape detector still drives status).
 *
 * ponytail: config merge is one shallow level (top-level keys + the hooks map).
 * Deep-merging arbitrary nested user config is out of scope — a user who needs
 * that level of fidelity can point HERMES_HOME at the overlay and edit by hand.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdirSync, readdirSync, symlinkSync, lstatSync, readlinkSync, writeFileSync, readFileSync, rmSync,
} from "node:fs";
import { parse, stringify } from "yaml";

// Files hivemind OWNS in the overlay (written real, never symlinked): the
// merged config with our hooks. The allowlist hermes records first-use hook
// consent into (shell-hooks-allowlist.json) is also NOT symlinked — approvals
// for OUR hook commands must not pollute the user's real allowlist.
const OWNED = new Set(["config.yaml", "shell-hooks-allowlist.json"]);

export interface SeedHermesHomeOpts {
  /** The HERMES_HOME overlay target dir. */
  hermesHome: string;
  /** The `hooks:` block to merge in (from hermesHooksConfig). */
  hooks: Record<string, unknown[]>;
  /** Override the real hermes home (tests). Default ~/.hermes. */
  realHermesHome?: string;
}

/** Parse the user's config.yaml (or {} when absent/corrupt). */
function readUserConfig(real: string): Record<string, unknown> {
  try {
    const doc = parse(readFileSync(join(real, "config.yaml"), "utf8"));
    return typeof doc === "object" && doc !== null ? (doc as Record<string, unknown>) : {};
  } catch {
    return {}; // corrupt/unreadable → start from defaults rather than fail the tile
  }
}

/** Symlink every real child into the overlay, then write the merged config. */
export function seedHermesHome(opts: SeedHermesHomeOpts): string {
  const real = opts.realHermesHome ?? join(homedir(), ".hermes");
  const home = opts.hermesHome;
  mkdirSync(home, { recursive: true });

  let children: import("node:fs").Dirent[] = [];
  try { children = readdirSync(real, { withFileTypes: true }); }
  catch { /* no real ~/.hermes yet (fresh install) — merged config only */ }

  for (const c of children) {
    if (OWNED.has(c.name)) continue; // hivemind owns these (written below)
    const link = join(home, c.name);
    const target = join(real, c.name);
    try {
      // Already the right symlink? leave it. Wrong/stale link? replace it. A
      // real file/dir hermes wrote into the overlay? leave it (don't clobber).
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

  // Merge our hook events into the user's own config (user entries are
  // preserved; ours append per event key).
  const cfg = readUserConfig(real);
  const userHooks = (cfg.hooks && typeof cfg.hooks === "object" ? cfg.hooks : {}) as Record<string, unknown[]>;
  const merged: Record<string, unknown[]> = { ...opts.hooks, ...userHooks };
  for (const [evt, entries] of Object.entries(opts.hooks)) {
    const ours = entries as unknown[];
    const theirs = userHooks[evt];
    merged[evt] = Array.isArray(theirs) ? [...ours, ...theirs] : ours;
  }
  cfg.hooks = merged;
  try { writeFileSync(join(home, "config.yaml"), stringify(cfg)); } catch { /* best-effort */ }
  return home;
}
