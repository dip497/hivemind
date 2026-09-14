/** Resume the newest chat with a conversation from
 *  ~/.cursor/chats/<md5(absolute cwd)>/<chatId>/meta.json — the id is not pre-assignable. */
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { AgentPlugin, SpawnSpec } from "../../types.js";

export function isCursor(spec: { cmd: string }): boolean {
  return basename(spec.cmd.trim().split(/\s+/)[0] ?? "") === "cursor-agent";
}

export function workspaceKey(cwd: string): string {
  return createHash("md5").update(cwd).digest("hex");
}

export function newestCursorChatForCwd(
  cwd: string,
  chatsRoot: string = join(homedir(), ".cursor", "chats"),
): string | undefined {
  const dir = join(chatsRoot, workspaceKey(cwd));
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return undefined; } // no chats for this workspace yet
  let best: { id: string; at: number } | undefined;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const meta = JSON.parse(readFileSync(join(dir, e.name, "meta.json"), "utf8")) as {
        updatedAtMs?: number; createdAtMs?: number; hasConversation?: boolean;
      };
      if (meta.hasConversation === false) continue; // opened, never used
      const at = meta.updatedAtMs ?? meta.createdAtMs ?? 0;
      if (!best || at > best.at) best = { id: e.name, at };
    } catch { /* no meta.json / unparseable → skip */ }
  }
  return best?.id;
}

export interface CursorResumeTransforms {
  transformSpecOnRestore: (spec: SpawnSpec, id: string) => SpawnSpec;
  restoreRetryTransform: (spec: SpawnSpec) => SpawnSpec | null;
}

export function makeCursorResumeTransforms(chatsRoot?: string): CursorResumeTransforms {
  return {
    transformSpecOnRestore: (spec) => {
      if (!isCursor(spec)) return spec;
      const args = spec.args ?? [];
      if (args.includes("--resume")) return spec; // already resuming
      const id = newestCursorChatForCwd(spec.cwd, chatsRoot);
      if (!id) return spec; // no chat for this workspace → fresh start
      return { ...spec, args: [...args, "--resume", id] };
    },
    // A stale chat id must not kill the tile: respawn fresh.
    restoreRetryTransform: (spec) => {
      if (!isCursor(spec)) return null;
      const args = spec.args ?? [];
      const i = args.indexOf("--resume");
      if (i < 0) return null;
      // The chat id is optional: `--resume --force` must keep --force.
      const drop = i + 1 < args.length && !args[i + 1]!.startsWith("-") ? 2 : 1;
      return { ...spec, args: [...args.slice(0, i), ...args.slice(i + drop)] };
    },
  };
}

import { cursor } from "./index.js";

export const plugin: AgentPlugin = {
  def: cursor,
  resume: () => makeCursorResumeTransforms(),
};
