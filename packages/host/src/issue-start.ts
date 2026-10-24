/**
 * Starting work on an issue (design jira-sync §10, §11.1), the one path the Issues tool's "Work on
 * this", a drag into an in-progress status and `hive ctl spawn --issue` share:
 *
 * - `issue.checkStart`: the start-work guard's findings for an issue, with what a start would do
 *   (its branch, the status it moves to, the prompt its agent is given), for a dialog to show.
 * - `issue.start`: the guard, and when nothing is left unconfirmed, "Assign to me" if asked, then
 *   the branch and its worktree frame, `branch:` and the start status on the issue, and an agent
 *   in that frame recorded on its tile as working the issue. A start that needs the person to
 *   confirm answers `{ started: false, left }`, never half-starts.
 * - `issue.assignMe`: "Assign to me" alone, for `hive ctl set-state --assign-me`.
 * - `issue.provideStart`: a tool plugin's service says it is the tracker for issues of a source
 *   (`jira:acme/PAY`) in its workspace, so the guard re-fetches them, asks its checks, and assigns
 *   through it.
 *
 * The guard is core's (`start-guard.ts`); what it can't know in core — the agents here and the
 * trackers' services — this adds. Electron-free.
 */
import fs from "node:fs";
import path from "node:path";
import { ApiError, fields, flag, text } from "@hivemind/workspace-api/protocol";
import { named, type Connection, type Domain } from "@hivemind/workspace-api/server";
import type { Method, Notice } from "@hivemind/workspace-api/methods";
import { findRoot, readConfig, readIssue, updateIssue } from "@hivemind/core/storage";
import { rootForId } from "@hivemind/core/json";
import { writeAgentContext } from "@hivemind/core/agent-context";
import { issueStartPrompt } from "@hivemind/core/templates";
import {
  START_CHECKS, branchFor, checkStartWork, providerFor, registerStartWorkProvider, startStatus, unacknowledged,
  type StartAnswer, type StartCheck, type StartFinding, type StartPlan, type StartWorkProvider,
} from "@hivemind/core/start-guard";
import type { Issue } from "@hivemind/core/types";
import type { PluginServices } from "./plugin-services.js";
import type { NameOf } from "./issues.js";

export interface IssueStartOptions {
  /** Every agent tile here working an issue now (`tile.issue`). */
  activeTiles(): { tile: string; issue: string }[];
  /** `frame.open(repo, {worktree: {branch, base}})`, as `from` asks it: the frame, its folder. */
  openWorktree(from: Connection, repo: string, branch: string, base?: string): Promise<{ frame: string; path: string }>;
  /** `agent.start(repo, start)`, as `from` asks it: the tile. */
  startAgent(from: Connection, repo: string, start: Record<string, unknown>): Promise<{ tile: string }>;
  /** The tool plugins' services, for `issue.provideStart`. */
  services: Pick<PluginServices, "call" | "pluginOf">;
  nameOf?: NameOf;
}

/** Whether `dir` is in a git work tree: a `.git` in it or a folder above. */
function inGit(dir: string): boolean {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return true;
    if (path.dirname(d) === d) return false;
  }
}

const ASSIGNMENT: readonly StartCheck[] = ["unassigned", "assigned-other", "in-progress-other"];

/** The commands a service names for each part of the provider hook. */
interface Provided { refresh?: string; checks?: string; assignMe?: string }

/** The tile an agent on the drive socket runs in, so its own tile doesn't count as another agent on the issue. */
const ownTile = (from: Connection): string | undefined => (from.actor.kind === "peer" ? from.actor.tile : from.actor.kind === "tile" ? from.actor.tile : undefined);

/** Who signs a change made over `from`: as `issues.ts` signs them. */
function signer(from: Connection, nameOf: NameOf | undefined): string {
  const { actor } = from;
  if (actor.kind !== "peer" || (actor.access === "owner" && !actor.client)) return "ui";
  return nameOf?.(from)?.trim() || actor.client || actor.person;
}

/** "Assign to me" makes the person at this machine the tracker's assignee: theirs to ask, their
 *  devices', or an agent's or program's on this machine; never a guest's. */
function mayAssign(from: Connection): boolean {
  const a = from.actor;
  return a.kind !== "peer" || a.access === "owner" || !!a.client || !!a.tile;
}

function checksOf(v: unknown, name: string): StartCheck[] {
  if (v == null) return [];
  if (!Array.isArray(v) || !v.every((c) => typeof c === "string" && (START_CHECKS as readonly string[]).includes(c))) {
    throw new ApiError("BAD_REQUEST", `${name} is a list of checks: ${START_CHECKS.join(", ")}`);
  }
  return v as StartCheck[];
}

export function issueStart(o: IssueStartOptions): Domain<Extract<Method, "issue.checkStart" | "issue.start" | "issue.assignMe">, Extract<Notice, "issue.provideStart">> {
  /** The providers services registered, by the connection that did, to take back when it goes. */
  const provided = new Map<Connection, Array<() => void>>();

  const verdict = async (from: Connection, root: string, id: string) => {
    const self = ownTile(from);
    return checkStartWork(root, id, { actor: signer(from, o.nameOf), activeTiles: o.activeTiles().filter((t) => t.tile !== self) });
  };

  const plan = async (from: Connection, root: string, id: string): Promise<StartPlan & { issue: Issue; git: boolean }> => {
    const { issue, findings } = await verdict(from, root, id);
    const branch = issue.branch ?? branchFor((await readConfig(root)).branch_template, issue);
    const status = issue.state === "in_progress" ? (issue.status ?? issue.state) : startStatus(root, issue);
    // A workspace that isn't in a git repository has no branches: its agent starts in its own frame.
    const git = inGit(path.dirname(root));
    return { id: issue.id, findings, branch, status, prompt: issueStartPrompt(issue, git ? branch : undefined), issue, git };
  };

  const assignMe = async (from: Connection, root: string, issue: Issue): Promise<void> => {
    if (!mayAssign(from)) throw new ApiError("FORBIDDEN", "Assign to me makes the person at this machine the assignee: only they, or their agents, may ask it");
    const p = providerFor(issue);
    if (!p?.assignMe) {
      throw new ApiError("UNSUPPORTED", issue.external
        ? `nothing here can assign ${issue.id} in ${issue.external.provider}: its plugin's service isn't running`
        : `${issue.id} is not mirrored from a tracker, so there is no one to assign it to`);
    }
    await p.assignMe(root, issue);
  };

  return {
    answers: {
      "issue.checkStart": async (from, root, id) => {
        const { issue: _, git: __, ...p } = await plan(from, text(root, "root"), text(id, "id"));
        return p;
      },
      "issue.assignMe": async (from, root, id) => {
        const r = text(root, "root");
        await assignMe(from, r, await readIssue(r, text(id, "id")));
        return readIssue(r, text(id, "id"));
      },
      "issue.start": async (from, repo, id, opts): Promise<StartAnswer> => {
        const at = text(repo, "repo");
        const o2 = opts == null ? {} : fields(opts, "opts");
        const ack = checksOf(o2.ack, "opts.ack");
        const force = flag(o2.force, "opts.force") === true;
        const wantAssign = flag(o2.assignMe, "opts.assignMe") === true;
        const spawn = o2.agent !== false;
        const root = await rootForId(await findRoot(at), text(id, "id"));
        const p = await plan(from, root, text(id, "id"));
        let left = unacknowledged(p.findings, { checks: ack, force });
        if (wantAssign) left = left.filter((f) => !ASSIGNMENT.includes(f.check));
        if (left.length) return { started: false, id: p.id, findings: p.findings, left };

        if (spawn && !path.isAbsolute(at)) throw new ApiError("UNSUPPORTED", "work on an issue is started in a workspace on this machine");
        if (wantAssign) await assignMe(from, root, p.issue);
        const who = signer(from, o.nameOf);
        let frame: { frame: string; path: string } | undefined;
        if (spawn && p.git) frame = await o.openWorktree(from, at, p.branch, typeof o2.base === "string" && o2.base ? o2.base : undefined);
        const moved = p.issue.state !== "in_progress";
        const patch = { ...(moved ? { status: p.status } : {}), ...(frame && p.issue.branch !== p.branch ? { branch: p.branch } : {}) };
        if (Object.keys(patch).length) {
          await updateIssue(root, p.id, patch, who, `started${wantAssign ? ", assigned to me" : ""}${frame ? ` on ${p.branch}` : ""}`);
          await writeAgentContext(root).catch(() => {});
        }
        let tile: string | undefined;
        if (spawn) {
          const agent = (o2.agent ?? {}) as Record<string, unknown>;
          if (typeof agent !== "object" || Array.isArray(agent)) throw new ApiError("BAD_REQUEST", "opts.agent is what to start ({program, model, mode, name}), or false");
          const pick = (k: string) => (typeof agent[k] === "string" && agent[k] ? { [k]: agent[k] } : {});
          ({ tile } = await o.startAgent(from, at, { ...pick("program"), ...pick("model"), ...pick("mode"), name: typeof agent.name === "string" && agent.name ? agent.name : p.id, ...(frame ? { frame: frame.frame } : {}), prompt: p.prompt, issue: p.id }));
        }
        return {
          started: true, id: p.id, findings: p.findings, status: moved ? p.status : (p.issue.status ?? p.issue.state),
          ...(frame ? { branch: p.branch, frame: frame.frame } : {}), ...(tile ? { tile } : {}), ...(wantAssign ? { assigned: true } : {}),
        };
      },
    },
    effects: {
      "issue.start": (_repo, id) => ({ target: named(id), detail: (r: StartAnswer) => (r?.started ? (r.tile ? `agent ${r.tile}` : "started") : "needs confirming") }),
      "issue.assignMe": (_root, id) => ({ target: named(id) }),
    },
    notices: {
      "issue.provideStart": (from, root, source, commands) => {
        const plugin = o.services.pluginOf(from);
        text(root, "root"); // the workspace it provides for, which a grant's connection may name alone
        const src = text(source, "source");
        if (!/^[a-z][a-z0-9-]*:/.test(src)) throw new Error(`${plugin}'s service: a source is <provider>:…, e.g. jira:`);
        const c = fields(commands, "commands") as Provided;
        const call = (command: string | undefined, args: unknown) => {
          if (!command) return null;
          const answer = o.services.call(plugin, command, args);
          if (!answer) throw new ApiError("UNAVAILABLE", `${plugin}'s service doesn't serve ${command}`);
          return answer;
        };
        const provider: StartWorkProvider = {
          source: src,
          ...(c.refresh ? { refresh: async (root: string, issue: Issue) => { await call(c.refresh, { root, id: issue.id }); return readIssue(root, issue.id); } } : {}),
          ...(c.checks ? { checks: async (root: string, issue: Issue) => { const r = await call(c.checks, { root, id: issue.id }); return Array.isArray(r) ? (r as StartFinding[]) : []; } } : {}),
          ...(c.assignMe ? { assignMe: async (root: string, issue: Issue) => { await call(c.assignMe, { root, id: issue.id }); } } : {}),
        };
        const offs = provided.get(from) ?? [];
        offs.push(registerStartWorkProvider(provider));
        provided.set(from, offs);
      },
    },
    gone: (connection) => {
      for (const off of provided.get(connection) ?? []) off();
      provided.delete(connection);
    },
  };
}

/** The agent tiles on `boards` that were started to work an issue: what check #11 reads. */
export function issueTiles(boards: readonly { core: { tiles: readonly { id: string; issue?: string }[] } | null }[]): { tile: string; issue: string }[] {
  return boards.flatMap((b) => (b.core?.tiles ?? []).flatMap((t) => (t.issue ? [{ tile: t.id, issue: t.issue }] : [])));
}

/** The domains `issue.start` goes through, as a host builds them: `frame.open` and `agent.start`. */
export function issueStartOver(
  frames: { answers: { "frame.open": (from: Connection, ...p: unknown[]) => unknown } },
  agents: { answers: { "agent.start": (from: Connection, ...p: unknown[]) => unknown } },
): Pick<IssueStartOptions, "openWorktree" | "startAgent"> {
  return {
    openWorktree: async (from, repo, branch, base) => (await frames.answers["frame.open"](from, repo, { worktree: { branch, ...(base ? { base } : {}) } })) as { frame: string; path: string },
    startAgent: async (from, repo, start) => (await agents.answers["agent.start"](from, repo, start)) as { tile: string },
  };
}
