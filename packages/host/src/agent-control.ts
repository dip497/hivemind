/**
 * Driving agents from another of the person's devices, their phone among them (M5, spec/agents.md):
 * what may be started in a workspace, starting one as the person launches it at their desktop,
 * interrupting its turn with the keys its manifest says do, closing it, and what it changed in the
 * folder it runs in. Electron-free: starting and closing are the control plane's, which the device
 * hands in.
 */
import { optionChoices, type AgentProviderDef } from "@hivemind/agents";
import { typeKeys } from "@hivemind/agent-host/keys";
import { machineCalled, type KnownMachines } from "@hivemind/core/remote-uri";
import type { CoreLayout } from "@hivemind/workspace-doc/shapes";
import { ApiError, fields, text, written } from "@hivemind/workspace-api/protocol";
import type { Domain } from "@hivemind/workspace-api/server";
import { toBareId } from "@hivemind/workspace-api/tile-id";
import { changesIn, type Changes } from "./agent-diff.js";

/** What starting an agent asks for. */
export interface Start {
  program: string;
  frame?: string;
  prompt?: string;
  model?: string;
  mode?: string;
}

export interface AgentControlOptions {
  /** The agents this device starts: switched on, their command found here. */
  programs(): AgentProviderDef[] | Promise<AgentProviderDef[]>;
  /** The board of the workspace at `repo`; null for one not here. */
  core(repo: string): CoreLayout | null;
  /** The machines this device knows, by what each is called. */
  machines: KnownMachines;
  /** Start `start.program` in the workspace at `repo`, in `start.frame` (none: its first frame), as
   *  the person launches it at their desktop: their saved options for it, with `model` and `mode`
   *  on top, never its unattended mode unless `mode` says so. Its tile. */
  start(repo: string, start: Start): Promise<string>;
  /** A tile's agent's status now. */
  status(tile: string): { state: string } | undefined;
  /** The keys its manifest says interrupt its turn; undefined for one that says none. */
  interruptKeys(tile: string): readonly string[] | undefined;
  /** Type `data` into the terminal of `tile` as the person types, now; false when it has none. */
  type(tile: string, data: string): boolean;
  /** End the session of `tile` and take it off its board; false when no workspace here has it. */
  close(tile: string): Promise<boolean>;
  /** The folder the agent of `tile` runs in: its frame's worktree's, else its frame's, else its
   *  workspace's; null for a tile on no board here. */
  folderOf(tile: string): string | null;
}

/** The longest prompt an agent is started with. */
export const PROMPT_MAX = 10_000;
/** The longest model or mode named. */
const CHOICE_MAX = 200;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_ANY = /[\u0000-\u001f\u007f]/;

/** An optional line of at most `max` characters with no control characters, `name`. */
function choice(value: unknown, name: string): string | undefined {
  if (value == null || value === "") return undefined;
  const v = written(value, name);
  if (v.length > CHOICE_MAX || CONTROL_ANY.test(v)) throw new ApiError("BAD_REQUEST", `${name} is one line of at most ${CHOICE_MAX} characters`);
  return v;
}

/** What starting asks for, checked. */
function startOf(value: unknown, programs: readonly AgentProviderDef[], core: CoreLayout): Start {
  const s = fields(value, "start");
  const program = text(s.program, "start.program");
  if (!programs.some((p) => p.id === program)) throw new ApiError("BAD_REQUEST", `${program} is not an agent this device starts`);
  const frame = s.frame == null ? undefined : text(s.frame, "start.frame");
  if (frame !== undefined && !core.frames.some((f) => f.id === frame)) throw new ApiError("BAD_REQUEST", `no frame ${frame} in this workspace`);
  let prompt: string | undefined;
  if (s.prompt != null) {
    prompt = written(s.prompt, "start.prompt");
    if (prompt.length > PROMPT_MAX || CONTROL.test(prompt)) throw new ApiError("BAD_REQUEST", `start.prompt is at most ${PROMPT_MAX} characters, with no control characters but newlines and tabs`);
  }
  const model = choice(s.model, "start.model");
  const mode = choice(s.mode, "start.mode");
  return { program, ...(frame ? { frame } : {}), ...(prompt ? { prompt } : {}), ...(model ? { model } : {}), ...(mode ? { mode } : {}) };
}

/** Whether `folder` is on this machine, where git can read it. */
const here = (folder: string): boolean => !/^[a-z][a-z0-9+.-]*:\/\//i.test(folder);

export function agentControl(o: AgentControlOptions): Domain<"agent.startable" | "agent.start" | "agent.interrupt" | "agent.close" | "agent.diff"> {
  const board = (repo: string): CoreLayout => {
    const core = o.core(repo);
    if (!core) throw new ApiError("BAD_REQUEST", "no such workspace here");
    return core;
  };
  return {
    answers: {
      "agent.startable": async (_from, repo) => {
        const core = board(text(repo, "workspace"));
        const programs = (await o.programs()).map((p) => ({
          id: p.id,
          label: p.label,
          options: (p.options ?? []).filter((x) => x.id === "model" || x.id === "mode").map((x) => ({ id: x.id, label: x.label, values: optionChoices(x, []) })),
        }));
        const frames = core.frames.map((f) => ({ id: f.id, name: f.title, machine: machineCalled(f.worktreePath ?? f.workspacePath ?? text(repo, "workspace"), o.machines) }));
        return { programs, frames };
      },
      "agent.start": async (_from, repo, start) => {
        const at = text(repo, "workspace");
        return { tile: await o.start(at, startOf(start, await o.programs(), board(at))) };
      },
      "agent.interrupt": (_from, tile) => {
        const bare = toBareId(text(tile, "tile"));
        const keys = o.interruptKeys(bare);
        if (!keys) throw new ApiError("BAD_REQUEST", "this agent says no keys that interrupt its turn");
        const state = o.status(bare)?.state;
        if (state !== "working" && state !== "waiting") return { interrupted: false };
        return { interrupted: typeKeys((bytes) => o.type(bare, bytes), keys) };
      },
      "agent.close": async (_from, tile) => ({ closed: await o.close(toBareId(text(tile, "tile"))) }),
      "agent.diff": async (_from, tile): Promise<Changes> => {
        const folder = o.folderOf(toBareId(text(tile, "tile")));
        if (folder === null) throw new ApiError("BAD_REQUEST", "no such agent here");
        if (!here(folder)) throw new ApiError("FAILED", "this agent runs on another machine: what it changed is read there");
        return changesIn(folder);
      },
    },
    effects: {
      "agent.start": () => ({ target: (r) => (r as { tile?: string } | undefined)?.tile }),
      "agent.interrupt": (tile) => ({ target: typeof tile === "string" ? toBareId(tile) : undefined }),
      "agent.close": (tile) => ({ target: typeof tile === "string" ? toBareId(tile) : undefined }),
    },
  };
}
