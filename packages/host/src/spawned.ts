/**
 * Tiles the control plane spawns on a host with no window (`hive host`): nobody lays one out and
 * opens it, so the host starts its session itself, in the folder of the frame it went to, and
 * watches it from its first byte (its output is recorded and it runs on whoever shows it). It
 * starts the agent as a window would (agent-start.ts): the first task on its command line where
 * the agent takes one there, else typed once its screen settles, and a startup screen its launch
 * flags already answered skipped.
 */
import type { TileRecord } from "@hivemind/workspace-doc/shapes";
import { agentForCmd } from "@hivemind/agents";
import { deliversPromptViaArgv } from "@hivemind/agent-host/agent-io";
import { AgentStart, START_TICK_MS, typeTask } from "@hivemind/agent-host/agent-start";
import { KEY_GAP_MS, keyBytes } from "@hivemind/agent-host/keys";
import type { WorkspaceStore } from "@hivemind/workspace-host/store";
import { toPtyId } from "@hivemind/workspace-api/tile-id";
import type { Terminals } from "./terminals.js";

/** The size a session the host starts runs at, until someone shows it at theirs. */
const COLS = 120;
const ROWS = 36;

export interface SpawnedOptions {
  store: Pick<WorkspaceStore, "getCore">;
  terminals: Pick<Terminals, "own">;
  /** Write to a session now, by pty id. */
  write(ptyId: string, data: string, paste?: boolean): void;
  /** Whether the host still holds a session, by pty id. */
  holds(ptyId: string): boolean;
  /** A session's status now (tile-status.ts), by bare tile id. */
  status(bareTile: string): string | undefined;
  /** A session's screen as text, line by line; null when it has none. */
  screen(ptyId: string): Promise<string | null>;
  onWarn(message: string): void;
}

/** Start the session of the tile the control plane just spawned into the workspace at `repo`. */
export async function startSpawned(o: SpawnedOptions, spawn: { tileId: string; repo: string; prompt?: string }): Promise<void> {
  const core = o.store.getCore(spawn.repo);
  const tile = core?.tiles.find((t) => t.id === spawn.tileId) as (TileRecord & { args?: string[] }) | undefined;
  if (!core || !tile?.cmd) return o.onWarn(`tile ${spawn.tileId} is not in ${spawn.repo}: its session was not started`);
  const frame = core.frames.find((f) => f.id === core.frameOf?.[tile.id]);
  const def = agentForCmd(tile.cmd);
  const argv = !!spawn.prompt && deliversPromptViaArgv(def?.id);
  const ptyId = toPtyId(tile.id);
  const start = new AgentStart(def, Date.now());
  let task = argv ? undefined : spawn.prompt;
  let dirty = true;
  let tick: ReturnType<typeof setInterval> | undefined;
  let looking = false;
  const stop = () => { if (tick) clearInterval(tick); tick = undefined; };
  /** One look at the agent: a startup screen to skip, a task that may go in now. */
  const look = async (): Promise<void> => {
    const now = Date.now();
    if (!tick || looking) return;
    if (!o.holds(ptyId) || (!task && !start.mayDismiss(now))) return stop();
    looking = true;
    try {
      const keys = start.mayDismiss(now) ? start.dismiss((await o.screen(ptyId)) ?? "", now) : null;
      keys?.forEach((k, i) => setTimeout(() => o.write(ptyId, keyBytes(k)), KEY_GAP_MS * i));
      if (task && start.settled(dirty, o.status(tile.id))) {
        typeTask((data, paste) => o.write(ptyId, data, paste), task, () => o.status(tile.id) === "idle");
        task = undefined;
      }
      dirty = false;
    } finally {
      looking = false;
    }
  };
  let ended = false;
  try {
    const { pid } = await o.terminals.own(
      {
        tileId: ptyId,
        cwd: frame?.worktreePath ?? frame?.workspacePath ?? spawn.repo,
        cmd: tile.cmd,
        args: tile.args ?? [],
        cols: COLS,
        rows: ROWS,
        ...(argv ? { initialPrompt: spawn.prompt } : {}),
      },
      { data: () => { dirty = true; }, exit: () => { ended = true; stop(); } },
    );
    if (pid === -1) return o.onWarn(`tile ${tile.id}: its session did not start`);
  } catch (e) {
    return o.onWarn(`tile ${tile.id}: its session did not start: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (ended || (!task && !start.mayDismiss(Date.now()))) return;
  tick = setInterval(() => void look(), START_TICK_MS);
  tick.unref?.();
}
