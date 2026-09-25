/**
 * THE agent catalog — the single list of provider defs every surface reads
 * (desktop UI, `hive` CLI, HCP, the status detectors). Browser-safe: identity,
 * capabilities, icons and scrape detectors only.
 *
 * Nothing is compiled in: every agent arrives as a manifest — installed from the
 * HiveHub catalog, a folder, or a repository — and `setCatalog` is called with
 * what the disk scan found. An empty catalog (nothing installed) is legitimate.
 */
import type { AgentProviderDef, SpawnOptions, TileStatus } from "./types.js";
import { optionArgs } from "./options.js";

let active: readonly AgentProviderDef[] = [];
let BY_ID = new Map<string, AgentProviderDef>();
let BY_BIN = new Map<string, AgentProviderDef>();
let BY_ALIAS = new Map<string, AgentProviderDef>();
const listeners = new Set<() => void>();

function reindex(): void {
  BY_ID = new Map(active.map((d) => [d.id, d]));
  BY_BIN = new Map(active.map((d) => [d.bin, d]));
  BY_ALIAS = new Map<string, AgentProviderDef>();
  for (const d of active) {
    if (!d.detect) continue; // no detector → not recognised for status
    BY_ALIAS.set(d.bin, d);
    BY_ALIAS.set(d.id, d);
    for (const a of d.aliases ?? []) BY_ALIAS.set(a, d);
  }
}
reindex();

/** Don't snapshot at module scope: a rescan would be invisible to the copy. */
export function getCatalog(): readonly AgentProviderDef[] {
  return active;
}

export function setCatalog(defs: readonly AgentProviderDef[]): void {
  active = [...defs];
  reindex();
  for (const fn of [...listeners]) fn();
}

export function subscribeCatalog(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function agentById(id: string | undefined | null): AgentProviderDef | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** Basename of the first token of a command line (`/usr/local/bin/claude --x` → `claude`). */
export function binOf(cmd: string | undefined | null): string {
  return (cmd ?? "").trim().split(/\s+/)[0]?.split("/").pop() ?? "";
}

/** The provider hivemind SPAWNS for a command — exact binary match (a bare
 *  `kiro` is the Kiro IDE, not the `kiro-cli` agent). */
export function agentForCmd(cmd: string | undefined | null): AgentProviderDef | undefined {
  return BY_BIN.get(binOf(cmd));
}

/** The provider a user-run command IDENTIFIES as, for status scraping — binary,
 *  id or alias. Broader than agentForCmd on purpose. */
export function identifyProvider(cmd: string | undefined | null): AgentProviderDef | undefined {
  return BY_ALIAS.get(binOf(cmd).toLowerCase());
}

/** The provider spawned when none is named: the first spawnable entry. The UI's
 *  spawn button, `hive ctl spawn` and HCP all default to it. Undefined when no
 *  agent is installed — callers must offer installing one, not spawn nothing. */
export function defaultAgent(): AgentProviderDef | undefined {
  // Undefined, never a throw: callers render in JSX, and a user can disable every agent.
  return active.find((x) => x.enabled) ?? active[0];
}

/** The agent a new tile starts when none is named: the user's choice if it can run
 *  here, else the first spawnable agent this machine has, else `defaultAgent()`.
 *  Undefined when no agent is installed. */
export function preferredAgent(chosen: string | undefined, installed: (def: AgentProviderDef) => boolean): AgentProviderDef | undefined {
  const spawnable = active.filter((d) => d.enabled);
  const pick = chosen ? spawnable.find((d) => d.id === chosen) : undefined;
  if (pick && installed(pick)) return pick;
  return spawnable.find(installed) ?? pick ?? defaultAgent();
}

/** Providers offered for spawning (UI pickers, `--agent` choices). */
export function spawnableAgents(): AgentProviderDef[] {
  return active.filter((d) => d.enabled);
}

/** Providers that can be driven as HCP workers (deterministic turn signal). */
export function workerAgents(): AgentProviderDef[] {
  return active.filter((d) => d.enabled && d.caps.turnSignal);
}

/** Status for a known provider id (falls back to idle for an unknown id). */
export function detectStatus(id: string, screen: string): TileStatus {
  return BY_ID.get(id)?.detect?.(screen) ?? "idle";
}

/** The spawn args a def wants for these options (its own vocabulary, or its
 *  default args), and the tile label for the n-th spawn. */
export function spawnArgsFor(def: AgentProviderDef, opts: SpawnOptions): string[] {
  return optionArgs(def, opts);
}
/** The part of a window title worth naming a tile by: `{task}` from the first matching
 *  template, "" when a template says the title carries none, else the title itself. */
export function taskFromTitle(def: AgentProviderDef | undefined, title: string): string {
  for (const tpl of def?.titles ?? []) {
    const parts = tpl.split(/(\{task\}|\{any\})/);
    const re = new RegExp(`^${parts.map((p) => (p === "{task}" ? "(.+?)" : p === "{any}" ? ".*?" : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("")}$`, "s");
    const m = re.exec(title);
    if (m) return (m[1] ?? "").trim();
  }
  return title;
}

/** How long a tile's name may be, whoever gives it: a person, a spawner or the agent. */
export const NAME_MAX = 80;

/** A name as one printable line: whitespace collapsed, control characters dropped, capped. */
export function cleanName(raw: string): string {
  return Array.from((raw ?? "").replace(/\s+/g, " ")).filter((ch) => ch >= " " && ch !== "\x7f").join("").trim().slice(0, NAME_MAX).trim();
}

/** What an agent's window title (OSC 0/2) says it is doing, or "" when it says nothing a tile
 *  should be called by. A leading status glyph (a spinner, a bullet) is the agent's own status
 *  display, not part of the name; the manifest's `titles` pick the task out of the rest. */
export function agentTitle(def: AgentProviderDef | undefined, raw: string): string {
  return taskFromTitle(def, cleanName(raw).replace(STATUS_GLYPHS, ""));
}

/** Leading status glyphs agents animate in their titles: the Braille block (spinners), circle
 *  and half-circle frames, stars and bullets. Status is shown from the agent's state, not here. */
const STATUS_GLYPHS = /^[\s\u2800-\u28ff\u25cb-\u25d7\u2605\u2606\u2726-\u274b·•∙‣⁃*◆◇◦◌]+/u;

/** How long a task line may be: a glance, not a sentence. */
const TASK_MAX = 40;

/** A task line from the prompt a tile was started with: its first clause, without links or
 *  markdown, cut at a word within TASK_MAX. What a tile shows until its agent says more. */
export function promptTask(prompt: string): string {
  const line = (prompt ?? "").replace(/https?:\/\/\S+/g, "").replace(/[`*_#>\[\]]/g, "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const clause = cleanName(line.split(/(?<=[.!?;:])\s|\s[—–-]\s/)[0] ?? "").replace(/[.!?;:]$/, "");
  if (clause.length <= TASK_MAX) return clause;
  const cut = clause.slice(0, TASK_MAX + 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : TASK_MAX).trim()}…`;
}

export function spawnLabelFor(def: AgentProviderDef, n: number, opts: SpawnOptions): string {
  return def.spawnLabel ? def.spawnLabel(n, opts) : `${def.label} #${n}`;
}

/** Every variable an installed agent says must not reach a terminal the host starts. */
export function envToUnset(): string[] {
  return [...new Set(getCatalog().flatMap((d) => d.launch?.unsetEnv ?? []))];
}

/** A session id goes on a command line. Anything that is not shaped like one — a path, a
 *  sentence, a secret that happened to sit in the field a manifest named — never does. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const isSessionId = (v: unknown): v is string => typeof v === "string" && SESSION_ID_RE.test(v);

/** A launch that continues session `id`: the agent's resume tokens, where its manifest puts them. */
export function withResume(def: AgentProviderDef, args: readonly string[], id: string): string[] {
  const resume = def.session?.resume;
  if (!resume) return [...args];
  const tokens = resume.args.map((t) => t.replace(/\{id\}/g, id));
  return resume.position === "before" ? [...tokens, ...args] : [...args, ...tokens];
}

/** Whether an agent's manifest says how to list its sessions. */
export function canListSessions(def: AgentProviderDef): boolean {
  const s = def.session;
  return !!(s?.list || s?.resume?.find || s?.resume?.exists);
}
