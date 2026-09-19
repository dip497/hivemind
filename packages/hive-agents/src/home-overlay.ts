/**
 * A private configuration home for an agent whose CLI keeps its settings in one.
 *
 * The problem it solves: to inject hooks we have to write into the agent's configuration,
 * and the agent's configuration is the user's — their login, their sessions, their history.
 * Writing there would mean editing a file we do not own; pointing the CLI at an empty
 * directory would log them out.
 *
 * So the overlay links every child of the real directory into a private one and writes only
 * the files we own beside them. Reads and writes flow through the links into the canonical
 * store; the hooks file is ours. Idempotent, never deletes anything real, and best-effort
 * throughout: if this fails the agent simply starts with its own home and loses the
 * deterministic signals, which is a degraded agent rather than a broken one.
 */
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentHome } from "./types.js";

/** Where the CLI is pointed, and where its configuration directory lives inside it. */
export function homePaths(home: AgentHome, privateDir: string): { root: string; dir: string } {
  const root = path.join(privateDir, home.root);
  return { root, dir: path.join(root, home.dir) };
}

/**
 * Build (or refresh) the overlay. `files` are written into the configuration directory
 * after the links, so a file we own always wins over a link of the same name.
 */
export function seedHome(
  home: AgentHome,
  privateDir: string,
  mirror: string,
  files: Record<string, string>,
): string {
  const { root, dir } = homePaths(home, privateDir);
  const owned = [...new Set([...Object.keys(files), ...(home.own ?? []).map((f) => f.name)])];
  mirrorInto(mirror, dir, owned);

  for (const file of home.own ?? []) {
    if (files[file.name] !== undefined) continue; // rendered content wins
    let body: Record<string, unknown> = {};
    if (file.merge) {
      try { body = JSON.parse(readFileSync(path.join(mirror, file.name), "utf8")) as Record<string, unknown>; }
      catch { /* none of theirs to carry over */ }
    }
    Object.assign(body, file.set ?? {});
    write(path.join(dir, file.name), JSON.stringify(body, null, 2));
  }
  for (const [name, body] of Object.entries(files)) write(path.join(dir, name), body);
  return root;
}

const write = (file: string, body: string): void => {
  try { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, body); }
  catch { /* best-effort: a home we could not write means a degraded agent, not a dead one */ }
};

/**
 * Link every child of `real` into `overlay`, except the paths we own. A directory that
 * contains something of ours is not linked whole — it is mirrored one level deeper, so the
 * user keeps everything else inside it (kiro's own custom agents live beside the one we
 * generate).
 */
function mirrorInto(real: string, overlay: string, owned: string[]): void {
  try { mkdirSync(overlay, { recursive: true }); } catch { return; }
  const here = new Set(owned.map((o) => o.split("/")[0]!));
  const deeper = new Map<string, string[]>();
  for (const o of owned) {
    const slash = o.indexOf("/");
    if (slash > 0) {
      const head = o.slice(0, slash);
      deeper.set(head, [...(deeper.get(head) ?? []), o.slice(slash + 1)]);
    }
  }

  let children: import("node:fs").Dirent[] = [];
  try { children = readdirSync(real, { withFileTypes: true }); }
  catch { /* the CLI has no configuration yet — the overlay is simply ours alone */ }

  for (const child of children) {
    if (here.has(child.name) && !deeper.has(child.name)) continue; // ours outright
    if (deeper.has(child.name)) continue; // handled below, one level deeper
    const link = path.join(overlay, child.name);
    const target = path.join(real, child.name);
    try {
      const st = lstatSync(link);
      // Already the right link: leave it. A stale link: replace it. Something real the
      // agent itself wrote into the overlay: leave that too — it is not ours to remove.
      if (!st.isSymbolicLink()) continue;
      if (readlinkSync(link) === target) continue;
      rmSync(link, { force: true });
    } catch { /* nothing there yet */ }
    try { symlinkSync(target, link); } catch { /* best-effort */ }
  }

  for (const [head, rest] of deeper) mirrorInto(path.join(real, head), path.join(overlay, head), rest);
}
