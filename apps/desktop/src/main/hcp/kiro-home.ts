/**
 * Seed the EPHEMERAL kiro KIRO_HOME override home. kiro-cli loads custom agent
 * configs from `<KIRO_HOME>/.kiro/agents/<name>.json` (selected with
 * `--agent <name>`), and we point kiro at this hivemind-owned home (per
 * install) so we can inject our own agent config (hooks + mcpServers.hive)
 * WITHOUT touching the user's real ~/.kiro.
 *
 * The home must still look complete to kiro — auth, settings, sessions,
 * steering, skills, prompts, and any OTHER custom agents the user already has
 * — so we SYMLINK every child of the real ~/.kiro into `<kiroHome>/.kiro`,
 * EXCEPT the one directory hivemind owns (`agents/`). Inside `agents/`, we
 * symlink every child of the real `~/.kiro/agents` too (preserving the user's
 * own custom agents), except the one file we own (`hivemind.json`), which we
 * write for real. Reads/writes to sessions/settings/steering/other-agents flow
 * through the symlinks into the canonical store, so login + `--resume(-id)` +
 * the user's own agents stay shared with their normal kiro-cli usage; only
 * `agents/hivemind.json` is ours.
 *
 * Modeled directly on hcp/droid-home.ts (same FACTORY_HOME_OVERRIDE-shaped
 * seam, `KIRO_HOME` for kiro) — see that file's docblock for the general
 * pattern this mirrors.
 *
 * Idempotent: safe to call on every daemon start. Never deletes the real
 * ~/.kiro. Best-effort — a failure just means kiro falls back to its normal
 * home (no `--agent hivemind` selected, deterministic hooks off; the
 * screen-scrape detector still drives status).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdirSync, readdirSync, symlinkSync, lstatSync, readlinkSync, writeFileSync, rmSync,
} from "node:fs";

// Top level: hivemind owns the whole `agents/` dir (as a REAL directory, not a
// symlink) so it can add its own file inside without touching the user's dir.
const OWNED_TOP = new Set(["agents"]);
// Inside `agents/`: hivemind owns only its own config file.
const OWNED_AGENT_FILE = "hivemind.json";

export interface SeedKiroHomeOpts {
  /** The KIRO_HOME override target dir (its `.kiro/` is populated). */
  kiroHome: string;
  /** The full `agents/hivemind.json` contents (from kiroAgentConfig). */
  agentConfig: unknown;
  /** Override the real kiro dir (tests). Default ~/.kiro. */
  realKiro?: string;
}

/** Symlink every child of `srcDir` into `destDir`, skipping names in `owned`.
 *  Leaves an already-correct symlink alone; replaces a stale/wrong one; never
 *  clobbers a real file/dir kiro itself wrote into the overlay. Shared helper
 *  for both the top-level ~/.kiro pass and the nested agents/ pass. */
function symlinkChildren(srcDir: string, destDir: string, owned: Set<string>): void {
  let children: import("node:fs").Dirent[] = [];
  try { children = readdirSync(srcDir, { withFileTypes: true }); }
  catch { return; /* source doesn't exist yet — nothing to link */ }
  for (const c of children) {
    if (owned.has(c.name)) continue;
    const link = join(destDir, c.name);
    const target = join(srcDir, c.name);
    try {
      const st = lstatSync(link);
      if (st.isSymbolicLink()) {
        if (readlinkSync(link) === target) continue;
        rmSync(link, { force: true });
      } else {
        continue; // a real file/dir already here — don't clobber
      }
    } catch { /* not present → create below */ }
    try { symlinkSync(target, link); } catch { /* best-effort */ }
  }
}

/** Symlink every child of the real ~/.kiro into <kiroHome>/.kiro (except
 *  `agents/`), symlink every child of the real agents/ dir into the overlay's
 *  agents/ (except our own file), then write our `agents/hivemind.json`.
 *  Returns the KIRO_HOME value to export. */
export function seedKiroHome(opts: SeedKiroHomeOpts): string {
  const real = opts.realKiro ?? join(homedir(), ".kiro");
  const dotKiro = join(opts.kiroHome, ".kiro");
  mkdirSync(dotKiro, { recursive: true });
  symlinkChildren(real, dotKiro, OWNED_TOP);

  const agentsDir = join(dotKiro, "agents");
  mkdirSync(agentsDir, { recursive: true });
  symlinkChildren(join(real, "agents"), agentsDir, new Set([OWNED_AGENT_FILE]));

  try {
    writeFileSync(join(agentsDir, OWNED_AGENT_FILE), JSON.stringify(opts.agentConfig, null, 2));
  } catch { /* best-effort */ }

  return opts.kiroHome;
}
