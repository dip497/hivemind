/**
 * An agent goes where its session starts. A machine runs an agent's launch (its hooks, its tile id)
 * from the manifests installed there, and a machine that only has `hive` (one added over ssh, a
 * `hive host`) has none: an agent started there would run bare, never reporting, so nothing would
 * know it is there. So a start carries the manifest folder of the agent it runs, as the machine
 * that starts it has it, and a daemon that has no agent of that id installs it first, as
 * `hive agents install <folder>` would. One it has already is never replaced.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentForCmd, getCatalog } from "@hivemind/agents";
import type { AgentPackage } from "./pty-protocol.js";

/** The most a carried folder may hold: an agent is a manifest and a few scripts. */
const MOST_BYTES = 2 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The files under `dir`, by their path in it; null when there are more bytes than an agent has. */
function filesIn(dir: string): Record<string, string> | null {
  const files: Record<string, string> = {};
  let bytes = 0;
  const walk = (at: string): boolean => {
    for (const e of fs.readdirSync(path.join(dir, at), { withFileTypes: true })) {
      const rel = at ? `${at}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!walk(rel)) return false; continue; }
      if (!e.isFile()) continue;
      const body = fs.readFileSync(path.join(dir, rel));
      bytes += body.length;
      if (bytes > MOST_BYTES) return false;
      files[rel] = body.toString("base64");
    }
    return true;
  };
  return walk("") ? files : null;
}

/** The manifest folder of the agent `cmd` runs, as this machine has it installed; none for a
 *  command no agent names, an agent of a repository (it stays that repository's), or one too big. */
export function agentPackageFor(cmd: string): AgentPackage | undefined {
  const def = agentForCmd(cmd);
  if (!def?.dir || def.sourceRoot) return undefined;
  try {
    const files = filesIn(def.dir);
    return files ? { id: def.id, files } : undefined;
  } catch {
    return undefined;
  }
}

/** Install the carried agent `pkg` here when this machine has no agent of its id; what it says it
 *  is must be what it is. Best-effort: a bad package starts the session with the agents here. */
export async function installCarried(pkg: unknown): Promise<void> {
  const p = pkg as Partial<AgentPackage> | null;
  if (!p || typeof p.id !== "string" || !ID.test(p.id) || !p.files || typeof p.files !== "object") return;
  if (getCatalog().some((d) => d.id === p.id)) return;
  const staged = fs.mkdtempSync(path.join(os.tmpdir(), "hive-agent-"));
  try {
    for (const [rel, body] of Object.entries(p.files)) {
      const to = path.resolve(staged, rel);
      if (typeof body !== "string" || !to.startsWith(staged + path.sep)) return;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, Buffer.from(body, "base64"));
    }
    const { installAgent, readAgentManifest, AGENT_MANIFEST_FILE } = await import("@hivemind/agents/load");
    const read = await readAgentManifest(path.join(staged, AGENT_MANIFEST_FILE), { source: "user", requireDirMatch: false });
    if (read.error || read.def?.id !== p.id) return;
    await installAgent(staged);
  } catch (e) {
    console.error(`[pty-daemon] the agent ${p.id} the start carried was not installed:`, (e as Error).message);
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
}
