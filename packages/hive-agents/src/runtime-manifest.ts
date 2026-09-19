/**
 * The runtime a manifest describes, and the daemon side that carries out what it asks for.
 *
 * Node-only: writing files and reading a session store are the daemon's job. A manifest
 * says which file and which directory; every path is built here, from the directory the
 * daemon handed out, so a manifest cannot name a place to write.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { findSession } from "./session.js";
import { readTrackedSession } from "./tile-session-store.js";
import { hookCommand, renderHookDocument } from "./hooks.js";
import { homePaths, seedHome } from "./home-overlay.js";
import { NO_PLAN, validatePlan, type AgentRuntime, type LaunchPlan, type LaunchRequest, type RuntimePaths } from "./runtime.js";
import type { AgentProviderDef, ProviderResumeTransforms, SpawnSpec } from "./types.js";

/** The closed set a manifest may ask for. An unknown one is left alone, so a typo shows up
 *  as a literal in the argument list rather than resolving to something unintended. */
const PLACEHOLDER = /\{(asset:[A-Za-z0-9][\w.-]{0,63}|hook(?:Cmd)?:[a-z][A-Za-z]{0,31}|hcpSock|hcpToken|tileId|agentId|cwd|private|home|execPath|session)\}/g;

/** What a substituted value must survive. A command line dropped into a JSON string has to
 *  be JSON, or a Windows path or a quoted argument silently breaks the file it lands in. */
type Escape = (value: string) => string;
const ESCAPE_JSON: Escape = (v) => JSON.stringify(v).slice(1, -1);
const ESCAPE_NONE: Escape = (v) => v;
const escapeFor = (name: string): Escape => (name.toLowerCase().endsWith(".json") ? ESCAPE_JSON : ESCAPE_NONE);

function resolve(
  text: string,
  req: LaunchRequest,
  def: AgentProviderDef,
  escape: Escape = ESCAPE_NONE,
  assetFile: (name: string) => string = (n) => n,
): string {
  const put = (value: string): string => escape(value);
  return text.replace(PLACEHOLDER, (whole, key: string) => {
    if (key.startsWith("asset:")) return put(path.join(req.paths.private, assetFile(key.slice(6))));
    // A command line, rendered and quoted here: a manifest that had to build one would be
    // one `'` away from running something else.
    if (key.startsWith("hookCmd:")) {
      const name = key.slice(8);
      const hook = req.paths.hooks[name];
      return hook ? put(hookCommand(name, hook, req)) : whole;
    }
    if (key.startsWith("hook:")) { const h = req.paths.hooks[key.slice(5)]; return h ? put(h.path) : whole; }
    switch (key) {
      case "hcpSock": return req.paths.hcpSock ? put(req.paths.hcpSock!) : whole;
      case "hcpToken": return req.paths.hcpToken ? put(req.paths.hcpToken!) : whole;
      case "tileId": return put(req.tileId);
      case "agentId": return put(def.id);
      case "cwd": return put(req.cwd);
      case "private": return put(req.paths.private);
      case "home": return put(req.paths.home);
      case "execPath": return put(req.paths.execPath);
      case "session": return req.session ? put(req.session) : whole;
      default: return whole;
    }
  });
}

/** A file whose contents name one tile belongs to that tile. Two tiles of the same agent
 *  running at once would otherwise share a file and overwrite each other's — which is a
 *  race that reads as "the wrong session reported its turn". */
const perTileName = (name: string, tileId: string): string => {
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  return `${stem}-${tileId.replace(/[^A-Za-z0-9._-]/g, "-")}${ext}`;
};

/** Every agent that reports through the control plane needs the same five variables. */
function hcpEnv(def: AgentProviderDef, req: LaunchRequest): Record<string, string> {
  return {
    HIVE_HCP_SOCK: req.paths.hcpSock!,
    HCP_TOKEN: req.paths.hcpToken!,
    HIVEMIND_TILE: req.tileId, // the agent's own `hive ctl` calls attribute to this tile
    HIVE_AGENT_ID: def.id, // signs the Activity rows it writes
    HIVE_AGENT_DEPTH: req.env.HIVE_AGENT_DEPTH ?? "0",
  };
}

/**
 * What this agent's manifest alone delivers. Undefined when the manifest asks for nothing
 * beyond its command — most agents, and the point: they need no runtime at all.
 */
export function manifestRuntime(
  def: AgentProviderDef,
  assetSource: (file: string) => string | undefined,
): AgentRuntime | undefined {
  if (!def.launch && !def.assets?.length && !def.session?.resume) return undefined;
  return {
    install: (paths: RuntimePaths): LaunchPlan => {
      if (def.home) {
        // The overlay is the same for every tile of this agent, so its hooks are written
        // once, attributed by the spawn environment rather than by name.
        const req: LaunchRequest = { tileId: "", cwd: "", args: [], env: {}, phase: "spawn", paths };
        const doc = renderHookDocument(def, req);
        const owned = doc && def.hooks?.file ? { [def.hooks.file]: doc } : {};
        seedHome(def.home, paths.private, resolve(def.home.mirror, req, def), owned);
      }
      // Only the assets that are the same for every tile. One that names a tile, a session
      // or a hook is rendered at launch instead.
      const files: Record<string, string> = {};
      for (const asset of def.assets ?? []) {
        const body = assetSource(asset.file);
        if (body !== undefined && !PLACEHOLDER.test(body)) files[asset.name] = body;
        PLACEHOLDER.lastIndex = 0;
      }
      return Object.keys(files).length ? { files } : NO_PLAN;
    },
    launch: (req: LaunchRequest): LaunchPlan => {
      const plan: LaunchPlan = {};
      // An asset that names this tile is written for this tile; one that is the same for
      // everyone was written once at install and is referenced where it lies.
      const perTile = new Map<string, string>();
      for (const asset of def.assets ?? []) {
        const body = assetSource(asset.file);
        if (body === undefined) continue;
        PLACEHOLDER.lastIndex = 0;
        const varies = PLACEHOLDER.test(body);
        PLACEHOLDER.lastIndex = 0;
        if (varies) perTile.set(asset.name, perTileName(asset.name, req.tileId));
      }
      const assetFile = (name: string): string => perTile.get(name) ?? name;
      const files: Record<string, string> = {};
      for (const asset of def.assets ?? []) {
        const actual = perTile.get(asset.name);
        if (!actual) continue;
        const body = assetSource(asset.file);
        if (body !== undefined) files[actual] = resolve(body, req, def, escapeFor(asset.name), assetFile);
      }
      if (Object.keys(files).length) plan.files = files;
      const env: Record<string, string> = {};
      if (def.launch?.hcp && req.paths.hcpSock && req.paths.hcpToken) Object.assign(env, hcpEnv(def, req));
      if (def.home) env[def.home.env] = homePaths(def.home, req.paths.private).root;
      for (const [k, v] of Object.entries(def.launch?.env ?? {})) env[k] = resolve(v, req, def, ESCAPE_NONE, assetFile);
      if (Object.keys(env).length) plan.env = env;

      // Arguments that name something inside the private home are only safe once it is
      // there; a seed that failed leaves the agent running plainly rather than erroring.
      const homeReady = !def.launch?.requiresHome || req.paths.homeReady === true;
      if (homeReady && def.launch?.subcommand) plan.subcommand = def.launch.subcommand;
      const args = homeReady ? (def.launch?.args ?? []).map((t) => resolve(t, req, def, ESCAPE_NONE, assetFile)) : [];
      // An argument pointing at a file that was never written would name a path that does
      // not exist; better to launch without it than to hand the CLI a broken flag.
      if (args.length && !args.some((a, i) => a === (def.launch!.args![i]) && a.includes("{asset:"))) plan.args = args;

      // The hooks document: an argument the agent reads inline, or a file it is pointed at.
      const doc = renderHookDocument(def, req);
      if (doc && def.hooks?.arg) plan.argsBefore = [def.hooks.arg, doc];
      else if (doc && def.hooks?.file && !def.home) {
        plan.files = { ...plan.files, [perTileName(def.hooks.file, req.tileId)]: doc };
      }

      const session = def.session;
      if (req.phase === "spawn" && session?.bind) {
        // A session we named can be asked for again; one the user is steering is theirs.
        const claimed = (session.bind.unless ?? []).some((flag) => req.args.includes(flag));
        if (!claimed) {
          plan.argsBefore = [...(plan.argsBefore ?? []), ...session.bind.args.map((t) => t.replace(/\{newId\}/g, randomUUID()))];
        }
      }
      if (req.phase === "restore" && session?.resume) {
        const resume = session.resume;
        const tokens = req.session
          ? resume.args.map((t) => t.replace(/\{id\}/g, req.session!))
          // Nothing to resume by name: some CLIs can still pick up their last conversation.
          : resume.fallback ?? [];
        if (tokens.length) {
          if (resume.position === "before") plan.argsBefore = [...(plan.argsBefore ?? []), ...tokens];
          // `beforeLaunch` is for a CLI whose help writes it that way round:
          // `kiro chat --resume-id <id> --agent hivemind`.
          else if (resume.position === "beforeLaunch") plan.args = [...tokens, ...(plan.args ?? [])];
          else plan.args = [...(plan.args ?? []), ...tokens];
        }
      }
      return plan;
    },
  };
}

/**
 * The session this agent would resume, in the order a manifest asks for: the live one our
 * tracker hook recorded for this tile (it follows whatever the user did inside the agent),
 * then the id bound when the tile first spawned, then whatever its own store says.
 */
export function sessionFor(
  def: AgentProviderDef,
  spec: { cwd: string; args?: readonly string[] },
  ctx: { tileId?: string; tileSessionsDir?: string; legacyMapFile?: string; sessionRoot?: string } = {},
): string | undefined {
  const resume = def.session?.resume;
  if (!resume) return undefined;
  if (resume.from?.tracked && ctx.tileId && ctx.tileSessionsDir) {
    const tracked = readTrackedSession(ctx.tileSessionsDir, ctx.tileId, ctx.legacyMapFile);
    if (tracked) return tracked;
  }
  if (resume.from?.bound) {
    const i = (spec.args ?? []).indexOf(resume.from.bound);
    const bound = i >= 0 ? (spec.args ?? [])[i + 1] : undefined;
    if (bound && !bound.startsWith("-")) return bound;
  }
  return resume.find ? findSession(resume.find, spec.cwd, ctx.sessionRoot) : undefined;
}

/** Carry out a plan: write what it asks for, then shape the command line. */
export function applyPlan(spec: SpawnSpec, plan: LaunchPlan, paths: RuntimePaths, trusted: boolean): SpawnSpec {
  const safe = validatePlan(plan, { trusted });
  if (safe.files && Object.keys(safe.files).length) {
    mkdirSync(paths.private, { recursive: true });
    for (const [name, body] of Object.entries(safe.files)) writeFileSync(path.join(paths.private, name), body);
  }
  let args = spec.args ?? [];
  // A CLI that works through a subcommand gets it, once: `kiro` alone would open its
  // picker instead of the session this tile is.
  if (safe.subcommand && !args.includes(safe.subcommand)) args = [safe.subcommand, ...args];
  const before = (safe.argsBefore ?? []).filter((a) => !args.includes(a));
  // Idempotent: a tile that already carries the flag keeps the one it has, so a user's own
  // command line always wins and a restore never doubles an argument.
  const after = safe.args && !args.includes(safe.args[0]!) ? safe.args : [];
  return {
    ...spec,
    args: before.length || after.length ? [...before, ...args, ...after] : args,
    env: safe.env ? { ...spec.env, ...safe.env } : spec.env,
  };
}

/** A runtime as the transforms the session manager applies. The daemon writes install
 *  files once; these run per launch. */
export function transformsFor(
  def: AgentProviderDef,
  runtime: AgentRuntime,
  paths: RuntimePaths,
  opts: { sessionRoot?: string; legacyMapFile?: string } = {},
): ProviderResumeTransforms {
  const isThisAgent = (spec: SpawnSpec): boolean =>
    path.basename((spec.cmd ?? "").trim().split(/\s+/)[0] ?? "") === def.bin;
  const run = (spec: SpawnSpec, tileId: string, phase: "spawn" | "restore"): SpawnSpec => {
    if (!isThisAgent(spec) || !runtime.launch) return spec;
    const session = phase === "restore"
      ? sessionFor(def, spec, { tileId, tileSessionsDir: paths.tileSessionsDir, legacyMapFile: opts.legacyMapFile, sessionRoot: opts.sessionRoot })
      : undefined;
    // The flag that bound the session at spawn is replaced by the resume, not kept beside it.
    const bound = def.session?.resume?.from?.bound;
    if (session && bound) {
      const i = (spec.args ?? []).indexOf(bound);
      if (i >= 0) spec = { ...spec, args: [...(spec.args ?? []).slice(0, i), ...(spec.args ?? []).slice(i + 2)] };
    }
    const plan = runtime.launch({
      tileId, cwd: spec.cwd, args: spec.args ?? [], env: spec.env ?? {}, phase, session,
      supervise: spec.env?.HIVE_SUPERVISE, paths,
    });
    return applyPlan(spec, plan, paths, !def.sourceRoot);
  };
  const marker = def.session?.resume?.args[0];
  const fallbackMarker = def.session?.resume?.fallback?.[0];
  // Older builds re-added the resume on every restore; drop the repeats a saved spec carries.
  const onceResumed = (spec: SpawnSpec): SpawnSpec => {
    const args = spec.args ?? [];
    if (!marker || args.filter((a) => a === marker).length < 2) return spec;
    const kept: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < args.length; i++) {
      if (args[i] === marker && i + 1 < args.length) {
        if (seen.has(args[i + 1]!)) { i++; continue; }
        seen.add(args[i + 1]!);
      }
      kept.push(args[i]!);
    }
    return { ...spec, args: kept };
  };
  return {
    transformSpecOnSpawn: (spec, tileId) => run(spec, tileId, "spawn"),
    transformSpecOnRestore: (saved, tileId) => {
      const spec = onceResumed(saved);
      return (spec.args ?? []).includes(marker ?? "\0")
        ? run(spec, tileId, "spawn") // already resuming: keep its own session, still wire it up
        : run(spec, tileId, "restore");
    },
    restoreRetryTransform: (spec) => {
      // A session that has since vanished must not kill the tile: abandon the resume. The
      // tile keeps its identity though — an agent that binds its session id binds the same
      // one again, so the next start continues the tile rather than becoming a stranger.
      if (!marker || !isThisAgent(spec)) return null;
      const args = spec.args ?? [];
      const i = args.indexOf(marker) >= 0 ? args.indexOf(marker) : (fallbackMarker ? args.indexOf(fallbackMarker) : -1);
      if (i < 0) return null;
      const carried = i + 1 < args.length && !args[i + 1]!.startsWith("-") ? args[i + 1] : undefined;
      const rest = [...args.slice(0, i), ...args.slice(i + (carried ? 2 : 1))];
      const bind = def.session?.bind;
      return {
        ...spec,
        args: carried && bind ? [...bind.args.map((t) => t.replace(/\{newId\}/g, carried)), ...rest] : rest,
      };
    },
  };
}
