/**
 * How an agent gets ready to run — one seam, three ways to fill it.
 *
 * A runtime answers two questions: what files does this agent need on disk, and what does
 * its command line look like. It answers with a **description**, never an effect: a plan of
 * files, arguments and environment. The daemon performs it, so the same answer is valid
 * whether it came from a manifest, from a module we wrote, or one day from a plugin's own
 * code running where it cannot touch anything.
 *
 * That is the whole reason the contract is plain data. `LaunchRequest` in, `LaunchPlan`
 * out: both survive being serialised, so the seam that serves our agents in-process is the
 * seam that can serve someone else's across a sandbox. A runtime that could hand back a
 * function, a path outside its own directory, or a command to run would not have that
 * property — and would quietly make "everything is a plugin" untrue again.
 */
import type { AgentProviderDef } from "./types.js";

/** A hook script and the single argument it takes. Both are the daemon's to decide. */
export interface HookScript {
  path: string;
  arg?: string;
}

/** Paths the daemon owns. A runtime may point at these; it never invents one. */
export interface RuntimePaths {
  /** This agent's own directory — the only place its files are written. */
  private: string;
  /** Hivemind's hook scripts by name (`tracker`, `stop`, `userPrompt`, …). Ours, not the
   *  agent's: every agent wires up the same scripts, in its own configuration format — and
   *  the daemon knows what each one is called with, so a manifest never builds a command. */
  hooks: Readonly<Record<string, HookScript>>;
  /** The binary that runs a hook script (Electron as node). */
  execPath: string;
  /** Control plane, when the daemon has one. */
  hcpSock?: string;
  hcpToken?: string;
  /** Where per-tile session records live. */
  tileSessionsDir: string;
  /** The user's home, for an agent whose CLI keeps its own configuration there. */
  home: string;
  /** The agent's private configuration home was seeded. Arguments that select something
   *  inside it are only added when this is true. */
  homeReady?: boolean;
}

/** Everything a runtime is told about one launch. Plain data, deliberately. */
export interface LaunchRequest {
  tileId: string;
  cwd: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  /** A fresh session, or a tile the daemon is bringing back. */
  phase: "spawn" | "restore";
  /** The session found for this cwd, when the manifest said where to look. */
  session?: string;
  /** Set when this tile runs unattended under supervision. */
  supervise?: string;
  paths: RuntimePaths;
}

/** What a runtime answers. Every field is a description the daemon carries out. */
export interface LaunchPlan {
  /** Written into the agent's private directory: file name → contents. */
  files?: Readonly<Record<string, string>>;
  /** Placed before the arguments the tile already has — a flag its CLI wants early. */
  argsBefore?: readonly string[];
  /** Appended after them. */
  args?: readonly string[];
  /** A subcommand the command line must go through; added when it is not already there. */
  subcommand?: string;
  /** Merged over the environment. */
  env?: Readonly<Record<string, string>>;
}

/**
 * An agent's runtime. Both halves are optional: most agents need only one, and an agent
 * that needs neither is a manifest with nothing but a command — which is fine, and common.
 */
export interface AgentRuntime {
  /** Files that do not depend on a tile, written once when the daemon starts. */
  install?(paths: RuntimePaths): LaunchPlan;
  /** Files, arguments and environment for one launch. */
  launch?(req: LaunchRequest): LaunchPlan;
}

/** Nothing to do — the honest answer for an agent that just runs its command. */
export const NO_PLAN: LaunchPlan = Object.freeze({});

/**
 * A plan is untrusted input, even from our own manifests: it decides what is written to
 * disk and what reaches a command line. Anything outside the contract is dropped rather
 * than corrected, so a mistake shows up as a missing argument, never as a surprising one.
 */
export function validatePlan(plan: LaunchPlan, opts: { trusted?: boolean } = {}): LaunchPlan {
  const out: LaunchPlan = {};
  const files = Object.entries(plan.files ?? {}).filter(([name, body]) =>
    /^[A-Za-z0-9][\w.-]{0,127}$/.test(name) && typeof body === "string" && body.length <= 2 << 20);
  if (files.length) out.files = Object.fromEntries(files);
  const clean = (args: readonly string[] | undefined): string[] =>
    (args ?? []).filter((a) => typeof a === "string" && a.length > 0 && a.length <= 4096 && !a.includes("\0"));
  for (const key of ["argsBefore", "args"] as const) {
    const args = clean(plan[key]);
    if (args.length) out[key] = args;
  }
  if (typeof plan.subcommand === "string" && /^[\w-]{1,32}$/.test(plan.subcommand)) out.subcommand = plan.subcommand;
  const env = Object.entries(plan.env ?? {}).filter(([k, v]) =>
    /^[A-Z][A-Z0-9_]{0,63}$/.test(k) && typeof v === "string" && !v.includes("\0")
    && (opts.trusted || !LOADER_VARS.has(k)));
  if (env.length) out.env = Object.fromEntries(env);
  return out;
}

/** Variables that change how a process loads code rather than what it does. */
const LOADER_VARS = new Set(["LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS", "PATH", "PYTHONPATH", "PYTHONSTARTUP", "BASH_ENV", "ENV", "SHELL", "IFS", "ELECTRON_RUN_AS_NODE"]);

/** An agent that ships in the box is trusted with its own plan; a plugin is not. */
export const runtimeTrust = (def: AgentProviderDef): { trusted: boolean } => ({ trusted: !def.sourceRoot });
