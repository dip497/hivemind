/**
 * Sharing from the command line: the same `people.*` calls the app's Share and People panel make,
 * answered by the running `hive host`, or by the running app when no host runs here, and recorded
 * in its audit log as the person at this machine.
 *
 *   hive share <workspace> [--role view|edit|terminals] [--uses n] [--expires 7d]
 *   hive people requests | allow <req> [--role] | deny <req> | list | role <person> <role>
 *               | remove <person> | rule [ask|invite]          [--workspace <workspace>]
 *   hive join <link>      ask to join; waits while the owner decides
 */
import { defineCommand } from "citty";
import path from "node:path";
import type { JoinRequests, PersonHere } from "@hivemind/workspace-api/people";
import type { JoinReply } from "@hivemind/workspace-host/join";
import { appData } from "../app-data.js";
import { err, ok, type OutCtx } from "../format.js";
import { EXIT, HcpCliError, hcpCall } from "../hcp.js";
import { askHost, controlSocket, HostNotRunning } from "../host-control.js";

const LINK_ROLES = ["view", "edit", "terminals"];
const ROLES = [...LINK_ROLES, "agents"];

/** `7d`, `12h`, `30m`, `90s`, or seconds: in ms. */
export function duration(text: string): number | null {
  const m = /^(\d+)([smhd]?)$/.exec(text.trim());
  if (!m || Number(m[1]) < 1) return null;
  return Number(m[1]) * { "": 1, s: 1, m: 60, h: 3600, d: 86_400 }[m[2] as "" | "s" | "m" | "h" | "d"] * 1000;
}

/** Ask `hive host`; with none here, the running app, on its control-plane socket. */
async function ask(ctx: OutCtx, cmd: string, args: Record<string, unknown>, ms = 10_000): Promise<unknown> {
  try {
    try {
      return await askHost(controlSocket(appData()), cmd, args, ms);
    } catch (e) {
      if (!(e instanceof HostNotRunning)) throw e;
      try {
        return await hcpCall(`host.${cmd}`, args, ms);
      } catch (a) {
        if (a instanceof HcpCliError && a.code === "UNAVAILABLE") return err(ctx, "host_not_running", `${e.message}; nor is the hivemind app (${a.message})`, EXIT.unavailable);
        throw a;
      }
    }
  } catch (e) {
    return err(ctx, "refused", e instanceof Error ? e.message : String(e));
  }
}

const call = (ctx: OutCtx, method: string, ...params: unknown[]) => ask(ctx, "people", { method, params });

/** The folder of the host's workspace `given` names (its folder, its name, or its id's start);
 *  none given: the one this folder is in, or the host's only one. */
async function workspaceOf(ctx: OutCtx, given: unknown): Promise<string> {
  const { workspaces } = (await ask(ctx, "status", {})) as { workspaces: Array<{ repo: string; workspace: string | null }> };
  const g = typeof given === "string" && given ? given : null;
  const cwd = process.cwd();
  const found = g
    ? workspaces.filter((w) => w.repo === path.resolve(g) || path.basename(w.repo) === g || (g.length >= 4 && !!w.workspace?.startsWith(g)))
    : workspaces.filter((w) => cwd === w.repo || cwd.startsWith(`${w.repo}${path.sep}`));
  const one = found.length === 1 ? found[0] : !g && workspaces.length === 1 ? workspaces[0] : undefined;
  if (one) return one.repo;
  const names = workspaces.map((w) => path.basename(w.repo)).join(", ") || "none yet (`hive host add <folder>`)";
  return err(ctx, "usage", `${g ? `"${g}" names ${found.length ? "more than one" : "none"} of` : "say which of"} the host's workspaces (--workspace): ${names}`, EXIT.usage);
}

function role(ctx: OutCtx, given: unknown, allowed: string[]): string | undefined {
  if (given === undefined) return undefined;
  const r = String(given);
  if (allowed.includes(r)) return r;
  if (r === "agents") return err(ctx, "usage", "a link lets someone in at most to use terminals; give Can drive agents once they are here: `hive people role <person> agents`", EXIT.usage);
  return err(ctx, "usage", `--role is one of ${allowed.join(", ")}`, EXIT.usage);
}

const workspaceArg = { workspace: { type: "string", alias: "w", description: "which workspace (default: the one this folder is in, or the host's only one)" } } as const;
const json = { json: { type: "boolean" } } as const;

export const shareCmd = defineCommand({
  meta: { name: "share", description: "Make an invite link to one of this host's workspaces" },
  args: {
    workspace: { type: "positional", required: false, description: "its folder or name (default: the one this folder is in, or the host's only one)" },
    role: { type: "string", description: "what they may do: view, edit or terminals (default: edit)" },
    uses: { type: "string", description: "how many people it lets in (default: 1)" },
    expires: { type: "string", description: "how long it works: 30m, 12h, 7d … (default: 7d)" },
    ...json,
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const r = role(ctx, args.role, LINK_ROLES) ?? "edit";
    const uses = args.uses === undefined ? 1 : Number(args.uses);
    if (!Number.isSafeInteger(uses) || uses < 1) return err(ctx, "usage", "--uses is a whole number from 1", EXIT.usage);
    const ms = duration(String(args.expires ?? "7d"));
    if (!ms) return err(ctx, "usage", "--expires is a length of time: 30m, 12h, 7d", EXIT.usage);
    const repo = await workspaceOf(ctx, args.workspace);
    const link = (await call(ctx, "people.invite", repo, r, ms, uses > 1, ...(uses > 1 ? [uses] : []))) as string;
    const { answering } = (await call(ctx, "people.requests", repo)) as JoinRequests;
    return ok(ctx, { link, workspace: repo, role: r, uses, expires: Date.now() + ms, answering }, () => [
      link,
      `${uses === 1 ? "lets one person" : `lets ${uses} people`} into ${path.basename(repo)} to ${r}, for ${args.expires ?? "7d"}.`,
      answering === "ask" ? "You are asked about each: `hive people requests`, then `hive people allow <n>`." : "Anyone with it is let in at once (`hive people rule ask` to be asked).",
    ].join("\n"));
  },
});

/** Someone on the list, by their id's start or their name. */
async function personOf(ctx: OutCtx, repo: string, given: string): Promise<string> {
  const people = (await call(ctx, "people.list", repo)) as PersonHere[];
  const found = people.filter((p) => p.person.startsWith(given) || p.name === given);
  if (found.length === 1) return found[0]!.person;
  return err(ctx, "usage", `"${given}" names ${found.length ? "more than one person" : "nobody"} on ${path.basename(repo)}'s list (\`hive people list\`)`, EXIT.usage);
}

const requestsCmd = defineCommand({
  meta: { name: "requests", description: "Who is asking to join now" },
  args: { ...workspaceArg, ...json },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const repo = await workspaceOf(ctx, args.workspace);
    const r = (await call(ctx, "people.requests", repo)) as JoinRequests;
    return ok(ctx, r, () => (r.asking.length
      ? r.asking.map((q) => `${q.req}  ${q.profile.name || "someone"} asks to ${q.role}`).join("\n") + "\n`hive people allow <n>` or `hive people deny <n>`"
      : `nobody is asking to join ${path.basename(repo)}`));
  },
});

const answer = (allow: boolean) => defineCommand({
  meta: { name: allow ? "allow" : "deny", description: allow ? "Let someone asking to join in" : "Turn someone asking to join away" },
  args: {
    req: { type: "positional", required: true, description: "the number `hive people requests` shows" },
    ...(allow ? { role: { type: "string", description: "let them in at view, edit or terminals in place of their link's" } } : {}),
    ...workspaceArg,
    ...json,
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const req = Number(args.req);
    if (!Number.isSafeInteger(req) || req < 1) return err(ctx, "usage", "say which request by its number (`hive people requests`)", EXIT.usage);
    const r = allow ? role(ctx, (args as { role?: unknown }).role, LINK_ROLES) : undefined;
    const repo = await workspaceOf(ctx, args.workspace);
    const { answered } = (await call(ctx, "people.answer", repo, req, allow, ...(r ? [r] : []))) as { answered: boolean };
    if (!answered) return err(ctx, "not_waiting", `request ${req} is not waiting: answered already, or it timed out`);
    return ok(ctx, { answered, allow, ...(r ? { role: r } : {}) }, () => (allow ? `let in${r ? ` to ${r}` : ""}` : "turned away"));
  },
});

const listCmd = defineCommand({
  meta: { name: "list", description: "Who is on the workspace's list, their roles, and who is here now" },
  args: { ...workspaceArg, ...json },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const repo = await workspaceOf(ctx, args.workspace);
    const people = (await call(ctx, "people.list", repo)) as PersonHere[];
    return ok(ctx, people, () => (people.length
      ? people.map((p) => `${p.person.slice(0, 12)}  ${(p.name || "—").padEnd(16)} ${p.role.padEnd(9)} ${p.present ? "here" : ""}`).join("\n")
      : `nobody else is in ${path.basename(repo)} yet (\`hive share\`)`));
  },
});

const roleCmd = defineCommand({
  meta: { name: "role", description: "Change what someone may do: view, edit, terminals or agents (agents only while they are here)" },
  args: {
    person: { type: "positional", required: true, description: "their name, or their id's start (`hive people list`)" },
    role: { type: "positional", required: true },
    ...workspaceArg,
    ...json,
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const r = role(ctx, args.role, ROLES)!;
    const repo = await workspaceOf(ctx, args.workspace);
    const person = await personOf(ctx, repo, String(args.person));
    await call(ctx, "people.role", repo, person, r);
    return ok(ctx, { person, role: r }, () => `${String(args.person)} may ${r} now; they were reconnected`);
  },
});

const removeCmd = defineCommand({
  meta: { name: "remove", description: "Take someone off the workspace: they are disconnected and their link stops working" },
  args: { person: { type: "positional", required: true }, ...workspaceArg, ...json },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const repo = await workspaceOf(ctx, args.workspace);
    const person = await personOf(ctx, repo, String(args.person));
    await call(ctx, "people.remove", repo, person);
    return ok(ctx, { person, removed: true }, () => `${String(args.person)} is off ${path.basename(repo)}`);
  },
});

const ruleCmd = defineCommand({
  meta: { name: "rule", description: "Whether someone with a valid link is let in at once (invite) or you are asked first (ask, the default)" },
  args: { rule: { type: "positional", required: false, description: "ask or invite" }, ...workspaceArg, ...json },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const repo = await workspaceOf(ctx, args.workspace);
    if (args.rule !== undefined) {
      if (args.rule !== "ask" && args.rule !== "invite") return err(ctx, "usage", "the rule is ask or invite", EXIT.usage);
      await call(ctx, "people.answering", repo, args.rule);
    }
    const { answering } = (await call(ctx, "people.requests", repo)) as JoinRequests;
    return ok(ctx, { answering }, () => (answering === "ask" ? "you are asked about each person with a link" : "anyone with a valid link is let in at once, at its role"));
  },
});

export const peopleCmd = defineCommand({
  meta: { name: "people", description: "Who is in this host's workspaces, and who asks to join" },
  subCommands: { requests: requestsCmd, allow: answer(true), deny: answer(false), list: listCmd, role: roleCmd, remove: removeCmd, rule: ruleCmd },
});

/** What a refusal from the host means, in plain words. */
const WHY: Record<string, string> = {
  declined: "the owner said no, or did not answer in time",
  expired: "the link has expired or was used already",
  "not-this-device": "the link was made for another device",
  malformed: "the host did not understand the request",
};

export const joinCmd = defineCommand({
  meta: { name: "join", description: "Join a workspace with its invite link: waits while its owner decides" },
  args: { link: { type: "positional", required: true, description: "the hivemind://join/… link" }, ...json },
  async run({ args }) {
    const ctx = { json: !!args.json };
    if (!ctx.json) process.stderr.write("asking the owner… (up to three minutes)\n");
    // The owner has 170 s to answer, and the network a moment to reach them.
    const reply = (await ask(ctx, "join", { link: String(args.link) }, 200_000)) as JoinReply;
    if (!reply.ok) return err(ctx, reply.error, reply.error === "not-admitted" ? `the network turned this machine away: ${reply.message}` : WHY[reply.error] ?? reply.error);
    return ok(ctx, reply, () => `joined, to ${reply.role}`);
  },
});
