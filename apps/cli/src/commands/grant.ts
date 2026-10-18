/**
 * Programs the person lets drive workspaces here (spec/workspace-api.md "Drive socket"):
 *
 *   hive grant create <name> --workspace <folder, name or id>… [--role agents] [--expires 30d]
 *   hive grant list
 *   hive grant revoke <id>
 *
 * A program connects to the drive socket with the token `create` prints, names one of the
 * workspaces, and is answered there at its role.
 */
import { defineCommand } from "citty";
import path from "node:path";
import type { ClientGrant } from "@hivemind/workspace-api/grants";
import { err, ok } from "../format.js";
import { EXIT, HcpCliError } from "../hcp.js";
import { driveCall, driveSockPath } from "../drive.js";
import { duration } from "./share.js";
import { workspaceNamed, type HostWorkspace } from "../workspace-named.js";

const ROLES = ["view", "edit", "terminals", "agents"];
const json = { json: { type: "boolean" } } as const;

async function call(ctx: { json: boolean }, method: string, ...params: unknown[]): Promise<unknown> {
  try {
    return await driveCall(method, params);
  } catch (e) {
    if (e instanceof HcpCliError) return err(ctx, e.code.toLowerCase(), e.message, e.exit);
    throw e;
  }
}

const when = (ms: number | null): string => (ms === null ? "never" : new Date(ms).toISOString().replace(/\.\d+Z$/, "Z"));

const createCmd = defineCommand({
  meta: { name: "create", description: "Let a program drive workspaces here; prints its token once" },
  args: {
    name: { type: "positional", required: true, description: "what the program is called" },
    workspace: { type: "string", alias: "w", description: "a workspace it may drive, by its folder, name or id; give it again for more", required: true },
    role: { type: "string", description: "view, edit, terminals or agents (default: agents)" },
    expires: { type: "string", description: "how long it holds: 12h, 30d … (default: until taken back)" },
    ...json,
  },
  async run({ args, rawArgs }) {
    const ctx = { json: !!args.json };
    const role = String(args.role ?? "agents");
    if (!ROLES.includes(role)) return err(ctx, "usage", `--role is one of ${ROLES.join(", ")}`, EXIT.usage);
    // Each --workspace, in the order given: its folder, name or id.
    const given: string[] = [];
    for (let i = 0; i < rawArgs.length; i++) {
      const a = rawArgs[i]!;
      if (a === "--workspace" || a === "-w") given.push(rawArgs[++i] ?? "");
      else if (a.startsWith("--workspace=")) given.push(a.slice("--workspace=".length));
    }
    const { workspaces } = (await call(ctx, "host.status")) as { workspaces: HostWorkspace[] };
    const repos: string[] = [];
    for (const g of given) {
      const named = workspaceNamed(workspaces, g || null, process.cwd());
      if ("refused" in named) return err(ctx, "usage", named.refused, EXIT.usage);
      repos.push(named.repo);
    }
    let expires: number | null = null;
    if (args.expires !== undefined) {
      const ms = duration(String(args.expires));
      if (!ms) return err(ctx, "usage", "--expires is a length of time: 12h, 30d", EXIT.usage);
      expires = Date.now() + ms;
    }
    const made = (await call(ctx, "grant.create", { name: args.name, repos, role, expires })) as { grant: ClientGrant; token: string };
    return ok(ctx, { ...made, socket: driveSockPath() }, () => [
      made.token,
      `${made.grant.name} may ${role === "agents" ? "drive agents" : role} in ${made.grant.repos.map((r) => path.basename(r)).join(", ")}, ${expires === null ? "until you take it back" : `until ${when(expires)}`} (\`hive grant revoke ${made.grant.id}\`).`,
      `It connects to ${driveSockPath()} and says {"hello": {"token": "<this token>", "workspace": "<the folder>"}}. The token is not shown again.`,
    ].join("\n"));
  },
});

const listCmd = defineCommand({
  meta: { name: "list", description: "The programs let drive workspaces here" },
  args: { ...json },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const grants = (await call(ctx, "grant.list")) as ClientGrant[];
    return ok(ctx, grants, () => (grants.length
      ? grants.map((g) => `${g.id}  ${g.name}  ${g.role}  ${g.repos.join(", ")}  expires ${when(g.expires)}  last used ${g.lastUsed === null ? "never" : when(g.lastUsed)}`).join("\n")
      : "no program may drive workspaces here (`hive grant create`)"));
  },
});

const revokeCmd = defineCommand({
  meta: { name: "revoke", description: "Take a program's grant back; its connections close" },
  args: { id: { type: "positional", required: true, description: "the id `hive grant list` shows" }, ...json },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const { revoked } = (await call(ctx, "grant.revoke", args.id)) as { revoked: boolean };
    if (!revoked) return err(ctx, "not_found", `no grant ${args.id} (\`hive grant list\`)`, EXIT.notFound);
    return ok(ctx, { revoked }, () => `grant ${args.id} taken back`);
  },
});

export const grantCmd = defineCommand({
  meta: { name: "grant", description: "Let programs drive workspaces here, see them, take them back" },
  subCommands: { create: createCmd, list: listCmd, revoke: revokeCmd },
});
