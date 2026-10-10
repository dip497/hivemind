/**
 * What the control plane does that the workspace API asks by name (spec/workspace-api.md, 0.23):
 * name an agent, type keys to it, read its next reply or what it printed last, list the sessions it keeps, open a tool's
 * tile, pipe one agent's replies to another; and the person's own machine methods (a view event,
 * the plugins running in a window, a tile brought forward, rescans, settings, joining). The
 * control plane carries each out and records its effect as the caller's, once; an agent on the
 * drive socket is its tile, as in `hive ctl`. Electron-free.
 */
import type { Connection, Domain } from "@hivemind/workspace-api/server";
import { ApiError } from "@hivemind/workspace-api/protocol";
import type { AgentRead, AgentSessions } from "@hivemind/workspace-api/agents";
import { toPtyId as ptyId } from "@hivemind/workspace-api/tile-id";
import type { HcpCall } from "./control/protocol.js";

type Method =
  | "agent.rename" | "agent.keys" | "agent.read" | "agent.output" | "agent.sessions" | "tool.open" | "link.connect" | "link.disconnect"
  | "view.emit" | "plugin.commands" | "plugin.open" | "plugin.call" | "tile.focus"
  | "views.rescan" | "agents.rescan" | "widgets.rescan" | "tools.rescan" | "settings.reload" | "host.status" | "host.join";

export interface ControlApiOptions {
  /** The control plane: what it is asked, as `hive ctl` asks it. */
  control(): { dispatch(method: string, params: unknown, call: HcpCall): Promise<unknown> };
}

const text = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v) throw new ApiError("BAD_REQUEST", `${what} must be text`);
  return v;
};

export function controlApi(o: ControlApiOptions): Domain<Method> {
  /** Ask the control plane `method` as `from`, which the agent on the drive socket asks from its tile. */
  const ask = (from: Connection, method: string, params: Record<string, unknown>): Promise<unknown> => {
    const tile = from.actor.kind === "peer" ? from.actor.tile : undefined;
    return o.control().dispatch(method, { ...params, ...(tile ? { callerTile: ptyId(tile) } : {}) }, { actor: from.actor, signal: from.closed });
  };
  /** Asked for what it does: the API answers `null`. */
  const done = (method: string, params: (...p: unknown[]) => Record<string, unknown> = () => ({})) =>
    async (from: Connection, ...p: unknown[]) => { await ask(from, method, params(...p)); return null; };
  return {
    answers: {
      "agent.rename": async (from, tile, name) => {
        const r = (await ask(from, "tile.rename", { tileId: text(tile, "tile"), name: typeof name === "string" ? name : "" })) as { name: string };
        return { name: r.name };
      },
      "agent.keys": async (from, tile, keys) => {
        if (!Array.isArray(keys) || !keys.length || !keys.every((k) => typeof k === "string" && k)) throw new ApiError("BAD_REQUEST", "keys must be a list of key names or text");
        const r = (await ask(from, "agent.send_keys", { tileId: text(tile, "tile"), keys })) as { keys: number };
        return { keys: r.keys };
      },
      "agent.read": async (from, tile, timeoutMs) => {
        if (timeoutMs != null && !(typeof timeoutMs === "number" && timeoutMs > 0)) throw new ApiError("BAD_REQUEST", "timeoutMs must be a number of milliseconds");
        return (await ask(from, "agent.read", { tileId: text(tile, "tile"), ...(timeoutMs != null ? { timeoutMs } : {}) })) as AgentRead;
      },
      "agent.output": async (from, tile, lines) => {
        if (lines != null && !(Number.isInteger(lines) && (lines as number) > 0)) throw new ApiError("BAD_REQUEST", "lines must be a whole number");
        return (await ask(from, "agent.output", { tileId: text(tile, "tile"), ...(lines != null ? { lines } : {}) })) as { text: string };
      },
      "agent.sessions": async (from, place, program, limit) => {
        if (limit != null && !(typeof limit === "number" && limit > 0)) throw new ApiError("BAD_REQUEST", "limit must be a number");
        return (await ask(from, "agent.sessions", { agent: text(program, "program"), cwd: text(place, "place"), ...(limit != null ? { limit } : {}) })) as AgentSessions;
      },
      "tool.open": async (from, repo, tool) => {
        const t = (tool ?? {}) as { tool?: unknown; frame?: unknown; url?: unknown };
        const r = (await ask(from, "tool.open", { repo: text(repo, "repo"), tool: t.tool, frame: t.frame, url: t.url })) as { tileId: string };
        return { tile: r.tileId };
      },
      "link.connect": async (from, src, dst) => { await ask(from, "tile.connect", { srcTileId: text(src, "src"), dstTileId: text(dst, "dst") }); },
      "link.disconnect": async (from, src, dst) => {
        await ask(from, "tile.disconnect", { srcTileId: text(src, "src"), ...(dst != null ? { dstTileId: text(dst, "dst") } : {}) });
      },
      "view.emit": (from, name, data, view) => ask(from, "view.emit", { name, data, ...(view != null ? { view } : {}) }),
      "plugin.commands": (from) => ask(from, "plugin.commands", {}),
      "plugin.open": (from, plugin, frame) => ask(from, "plugin.open", { plugin, ...(frame != null ? { frame } : {}) }),
      "plugin.call": (from, plugin, command, args, tile) => ask(from, "plugin.call", { plugin, command, args, ...(tile != null ? { tile } : {}) }),
      "tile.focus": done("tile.focus", (tile) => ({ tileId: text(tile, "tile") })),
      "views.rescan": done("views.rescan"),
      "agents.rescan": done("agents.rescan"),
      "widgets.rescan": done("widgets.rescan"),
      "tools.rescan": done("tools.rescan"),
      "settings.reload": done("settings.reload"),
      "host.status": async (from) => (await ask(from, "host.status", {})) as { workspaces: Array<{ repo: string; workspace: string | null }> },
      "host.join": (from, link) => ask(from, "host.join", { link: text(link, "link") }),
    },
    // The control plane records each effect, as the caller's.
    effects: {},
  };
}
