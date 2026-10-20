/**
 * What the control plane does that the workspace API asks by name (spec/workspace-api.md, 0.23):
 * send an agent a message, name it, type keys to it, read its next reply or what it printed last,
 * put agents to sleep and wake them,
 * list the sessions it keeps, open a tool's tile, pipe one agent's replies to another; and the
 * person's own machine methods (a view event, the plugins running in a window, a tile brought
 * forward, rescans, settings, joining). Each effect is recorded as the caller's; an agent on the
 * drive socket asks from its tile, as in `hive ctl`. Electron-free.
 */
import type { Connection, Domain } from "@hivemind/workspace-api/server";
import { named } from "@hivemind/workspace-api/server";
import { ApiError } from "@hivemind/workspace-api/protocol";
import { toBareId } from "@hivemind/workspace-api/tile-id";
import { promptProblem } from "@hivemind/view-sdk/protocol";
import type { StartImage } from "@hivemind/workspace-api/agents";
import { imagesOf } from "./start-places.js";
import type { ControlWork } from "./control/methods.js";

type Method =
  | "agent.send" | "agent.rename" | "agent.keys" | "agent.read" | "agent.output" | "agent.sessions" | "agent.sleep" | "agent.wake" | "tool.open" | "link.connect" | "link.disconnect"
  | "view.emit" | "plugin.list" | "plugin.commands" | "plugin.open" | "plugin.call" | "plugin.close" | "tile.focus"
  | "views.rescan" | "agents.rescan" | "widgets.rescan" | "tools.rescan" | "settings.reload" | "host.status" | "host.join" | "host.add";

export interface ControlApiOptions {
  /** The control plane's work, once it is ready. */
  control(): Promise<ControlWork>;
  /** Keep the photos given with a message to the agent of `tile` (bare) on the machine it runs on:
   *  their paths. None: a message takes no photos here. */
  keep?(tile: string, images: StartImage[]): Promise<string[]>;
}

const text = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v) throw new ApiError("BAD_REQUEST", `${what} must be text`);
  return v;
};
/** The agent's tile a connection asks from: none for the person or a program. */
const callerOf = (from: Connection): string | undefined => (from.actor.kind === "peer" && from.actor.tile ? toBareId(from.actor.tile) : undefined);
const tileOf = (v: unknown): string | undefined => { const t = named(v); return t && toBareId(t); };
/** What a sleep or a wake is of: a tile or a frame; none, the whole workspace. */
const targetOf = (v: unknown): string | undefined => (v == null || v === "" ? undefined : text(v, "target"));
/** A pipe, or every pipe out of a tile: `src->dst`, `src->*`. */
const pipeOf = (src: unknown, dst: unknown): string | undefined => { const from = tileOf(src); return from && `${from}->${tileOf(dst) ?? "*"}`; };

export function controlApi(o: ControlApiOptions): Domain<Method> {
  /** Asked for what it does: the API answers `null`. */
  const done = (run: (w: ControlWork, ...p: unknown[]) => unknown) =>
    async (_from: Connection, ...p: unknown[]) => { await run(await o.control(), ...p); return null; };
  return {
    answers: {
      "agent.send": async (_from, tile, message, given) => {
        const images = imagesOf((given as { images?: unknown } | null | undefined)?.images);
        // With photos, the words may be none.
        const problem = images?.length && message === "" ? null : promptProblem(message);
        if (problem) throw new ApiError("BAD_REQUEST", problem);
        const t = text(tile, "tile");
        let photos: string[] | undefined;
        if (images?.length) {
          if (!o.keep) throw new ApiError("UNSUPPORTED", "a message here takes no photos");
          photos = await o.keep(toBareId(t), images);
        }
        const { sent, held } = (await o.control()).send(t, message as string, photos);
        return { sent, ...(held ? { held } : {}), ...(photos ? { photos } : {}) };
      },
      "agent.rename": async (_from, tile, name) => ({ name: (await o.control()).rename(text(tile, "tile"), typeof name === "string" ? name : "") }),
      "agent.keys": async (_from, tile, keys) => {
        if (!Array.isArray(keys) || !keys.length || !keys.every((k) => typeof k === "string" && k)) throw new ApiError("BAD_REQUEST", "keys must be a list of key names or text");
        return { keys: (await o.control()).keys(text(tile, "tile"), keys as string[]) };
      },
      "agent.read": async (_from, tile, timeoutMs) => {
        // 0: the turn as it stands, without waiting.
        if (timeoutMs != null && !(typeof timeoutMs === "number" && timeoutMs >= 0)) throw new ApiError("BAD_REQUEST", "timeoutMs must be a number of milliseconds");
        return (await o.control()).read(text(tile, "tile"), (timeoutMs as number | null | undefined) ?? undefined);
      },
      "agent.output": async (_from, tile, lines) => {
        if (lines != null && !(Number.isInteger(lines) && (lines as number) > 0)) throw new ApiError("BAD_REQUEST", "lines must be a whole number");
        return (await o.control()).output(text(tile, "tile"), (lines as number | null) ?? undefined);
      },
      "agent.sessions": async (_from, place, program, limit) => {
        if (limit != null && !(typeof limit === "number" && limit > 0)) throw new ApiError("BAD_REQUEST", "limit must be a number");
        return (await o.control()).sessions(text(program, "program"), text(place, "place"), (limit as number | null) ?? undefined);
      },
      "tool.open": async (from, repo, tool) => {
        const t = (tool ?? {}) as { tool?: unknown; frame?: unknown; url?: unknown };
        const r = text(repo, "repo");
        if (typeof t.tool !== "string") throw new ApiError("BAD_REQUEST", "tool must be an id: owner/name/tool");
        return { tile: await (await o.control()).openTool(callerOf(from), r, t.tool, { frame: t.frame, url: t.url }) };
      },
      "link.connect": async (_from, src, dst) => { (await o.control()).connect(text(src, "src"), text(dst, "dst")); },
      "link.disconnect": async (_from, src, dst) => { (await o.control()).disconnect(text(src, "src"), dst != null ? text(dst, "dst") : undefined); },
      "view.emit": async (from, name, data, view) => (await o.control()).viewEmit(callerOf(from), name, data, view),
      "plugin.list": async () => (await o.control()).pluginList(),
      "plugin.commands": async () => (await o.control()).pluginCommands(),
      "plugin.open": async (from, plugin, frame) => (await o.control()).pluginOpen(callerOf(from), plugin, frame),
      "plugin.call": async (_from, plugin, command, args, tile) => (await o.control()).pluginCall(plugin, command, args, tile),
      "plugin.close": async (_from, instance, plugin) => (await o.control()).pluginClose(text(instance, "instance"), plugin != null ? text(plugin, "plugin") : undefined),
      "tile.focus": done((w, tile) => w.focus(text(tile, "tile"))),
      "views.rescan": done((w) => w.rescan("views")),
      "agents.rescan": done((w) => w.rescan("agents")),
      "widgets.rescan": done((w) => w.rescan("widgets")),
      "tools.rescan": done((w) => w.rescan("tools")),
      "settings.reload": done((w) => w.reloadSettings()),
      "host.status": async () => (await o.control()).hostStatus(),
      "host.join": async (_from, link) => (await o.control()).join(text(link, "link")),
      "host.add": async (_from, folder) => (await o.control()).serve(text(folder, "folder")),
      "agent.sleep": async (_from, repo, target, force) => (await o.control()).sleep(text(repo, "repo"), targetOf(target), force === true),
      "agent.wake": async (_from, repo, target) => (await o.control()).wake(text(repo, "repo"), targetOf(target)),
    },
    effects: {
      "agent.send": (tile) => ({ target: tileOf(tile) }),
      "agent.rename": (tile) => ({ target: tileOf(tile) }),
      "agent.keys": (tile) => ({ target: tileOf(tile) }),
      "tool.open": () => ({ target: (r: { tile: string }) => r.tile }),
      "link.connect": (src, dst) => ({ target: pipeOf(src, dst) }),
      "link.disconnect": (src, dst) => ({ target: pipeOf(src, dst) }),
      "plugin.open": (plugin) => ({ target: named(plugin) }),
      "plugin.call": (plugin, command) => ({ target: named(plugin) && `${plugin as string}:${named(command) ?? ""}` }),
      "plugin.close": (instance) => ({ target: named(instance) }),
      "views.rescan": () => ({}),
      "agents.rescan": () => ({}),
      "widgets.rescan": () => ({}),
      "tools.rescan": () => ({}),
      "settings.reload": () => ({}),
      "host.add": (folder) => ({ target: named(folder) }),
      "agent.sleep": (repo, target) => ({ target: named(target) ?? named(repo) }),
      "agent.wake": (repo, target) => ({ target: named(target) ?? named(repo) }),
    },
  };
}
