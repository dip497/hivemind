/**
 * `@hivemind/mcp` — stdio MCP server that exposes hive-core operations as
 * tools for claude (or any MCP client). Used by `hive mcp-stdio` CLI command,
 * which `.mcp.json` at a workspace root wires up so claude auto-loads.
 *
 * Wraps existing hive-core functions; no new storage — markdown is still the
 * source of truth in v1.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  commentOnIssue,
  createIssue,
  deleteIssue,
  findRoot,
  listCycles,
  listIssues,
  readIssue,
  updateIssue,
  IssueStateZ,
  type Issue,
  type IssueState,
} from "@hivemind/core";
import type { IssuePatch } from "@hivemind/core/storage";

/** Resolve the repo root from $HIVE_ROOT (set by `hive mcp-stdio --root`)
 *  or by walking up from cwd. Throws if no .hivemind found. */
async function resolveRoot(): Promise<string> {
  const envRoot = process.env.HIVE_ROOT;
  if (envRoot) return envRoot;
  const root = await findRoot(process.cwd());
  if (!root) {
    throw new Error(
      "no .hivemind found — set HIVE_ROOT env var or run from a repo with `.hivemind/` at or above cwd",
    );
  }
  return root;
}

/** Compact JSON representation of an issue for tool responses (drops raw
 *  markdown body which can be huge; keeps parsed sections). */
function issueToJson(i: Issue) {
  return {
    id: i.id,
    title: i.title,
    state: i.state,
    parent: i.parent,
    labels: i.labels,
    assignee: i.assignee,
    github: i.github,
    cycle: i.cycle,
    created: i.created,
    updated: i.updated,
    description: i.sections.description,
    acceptanceCriteria: i.sections.acceptanceCriteria,
    activity: i.sections.activity,
  };
}

const TOOLS: Tool[] = [
  {
    name: "hive_get_issue",
    description:
      "Get a single issue by id (e.g. 'PAY-42'). Returns title, state, description, acceptance criteria, recent activity, labels, assignee.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Issue id like 'PAY-42'" } },
      required: ["id"],
    },
  },
  {
    name: "hive_list_issues",
    description:
      "List issues in the workspace. Optionally filter by state, label, or assignee. Returns lightweight summaries (no body).",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          enum: ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"],
        },
        label: { type: "string" },
        assignee: { type: "string", description: "assignee id (agent or member id)" },
      },
    },
  },
  {
    name: "hive_set_state",
    description:
      "Change an issue's state. Appends a row to the issue's activity log. Use when you start work, send for review, complete, or block.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        state: {
          type: "string",
          enum: ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"],
        },
        note: { type: "string", description: "Short reason for the state change" },
      },
      required: ["id", "state"],
    },
  },
  {
    name: "hive_add_comment",
    description:
      "Append a comment to an issue's activity log. Use for progress updates, decisions, blockers, or human-readable summaries of work done.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        message: { type: "string" },
      },
      required: ["id", "message"],
    },
  },
  {
    name: "hive_update_issue",
    description:
      "Patch an issue's fields: title, description, labels, assignee, parent, cycle. For state changes use hive_set_state instead.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        assignee: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["agent", "member"] },
            id: { type: "string" },
            model: { type: "string" },
          },
          required: ["type", "id"],
        },
        parent: { type: ["string", "null"] },
        cycle: { type: ["string", "null"] },
      },
      required: ["id"],
    },
  },
  {
    name: "hive_mark_acceptance",
    description:
      "Mark an acceptance criterion done (or undone). Indexes are 0-based, matching the order from hive_get_issue.acceptanceCriteria. Call this as you complete each criterion.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        index: { type: "integer", minimum: 0 },
        done: { type: "boolean" },
      },
      required: ["id", "index", "done"],
    },
  },
  {
    name: "hive_create_issue",
    description:
      "Create a new issue. Returns the new issue with allocated id. Use for sub-tasks discovered during work.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        parent: { type: "string", description: "parent issue id for sub-tasks" },
        labels: { type: "array", items: { type: "string" } },
        state: {
          type: "string",
          enum: ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"],
        },
      },
      required: ["title"],
    },
  },
  {
    name: "hive_delete_issue",
    description:
      "Delete an issue file. Destructive — only use when explicitly asked by the user.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "hive_list_cycles",
    description: "List all cycles (sprints) in the workspace.",
    inputSchema: { type: "object", properties: {} },
  },
];

const GetIssueArgs = z.object({ id: z.string() });
const ListIssuesArgs = z.object({
  state: IssueStateZ.optional(),
  label: z.string().optional(),
  assignee: z.string().optional(),
});
const SetStateArgs = z.object({ id: z.string(), state: IssueStateZ, note: z.string().optional() });
const AddCommentArgs = z.object({ id: z.string(), message: z.string().min(1) });
const UpdateIssueArgs = z.object({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  labels: z.array(z.string()).optional(),
  assignee: z
    .object({ type: z.enum(["agent", "member"]), id: z.string(), model: z.string().optional() })
    .nullable()
    .optional(),
  parent: z.string().nullable().optional(),
  cycle: z.string().nullable().optional(),
});
const MarkAcceptanceArgs = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  done: z.boolean(),
});
const CreateIssueArgs = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  parent: z.string().optional(),
  labels: z.array(z.string()).optional(),
  state: IssueStateZ.optional(),
});
const DeleteIssueArgs = z.object({ id: z.string() });

/** Build and return an MCP Server bound to hive-core. Caller transports it. */
export function buildServer(): Server {
  const server = new Server(
    { name: "hive", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const root = await resolveRoot();
    try {
      switch (name) {
        case "hive_get_issue": {
          const { id } = GetIssueArgs.parse(args);
          const issue = await readIssue(root, id);
          return jsonResult(issueToJson(issue));
        }
        case "hive_list_issues": {
          const a = ListIssuesArgs.parse(args ?? {});
          const all = await listIssues(root);
          const filtered = all.filter((i) => {
            if (a.state && i.state !== a.state) return false;
            if (a.label && !i.labels.includes(a.label)) return false;
            if (a.assignee && i.assignee?.id !== a.assignee) return false;
            return true;
          });
          return jsonResult(filtered);
        }
        case "hive_set_state": {
          const a = SetStateArgs.parse(args);
          // updateIssue already appends a state-change activity row internally.
          // We only add an extra comment when the user supplied a note (avoids
          // duplicate "state: todo → in_progress" entries in the activity log).
          await updateIssue(root, a.id, { state: a.state as IssueState }, actorTag());
          if (a.note) {
            await commentOnIssue(root, a.id, a.note, actorTag());
          }
          const after = await readIssue(root, a.id);
          return jsonResult(issueToJson(after));
        }
        case "hive_add_comment": {
          const a = AddCommentArgs.parse(args);
          // Signature: commentOnIssue(root, id, message, who?).
          await commentOnIssue(root, a.id, a.message, actorTag());
          const after = await readIssue(root, a.id);
          return jsonResult({ ok: true, activity: after.sections.activity.slice(-3) });
        }
        case "hive_update_issue": {
          const a = UpdateIssueArgs.parse(args);
          const patch: IssuePatch = {};
          if (a.title !== undefined) patch.title = a.title;
          if (a.description !== undefined) patch.description = a.description;
          if (a.labels !== undefined) patch.labels = a.labels;
          if (a.assignee !== undefined) patch.assignee = a.assignee;
          // IssuePatch uses `undefined` (not null) to mean "clear"; map both.
          if (a.parent !== undefined) patch.parent = a.parent ?? undefined;
          if (a.cycle !== undefined) patch.cycle = a.cycle ?? undefined;
          await updateIssue(root, a.id, patch, actorTag());
          const after = await readIssue(root, a.id);
          return jsonResult(issueToJson(after));
        }
        case "hive_mark_acceptance": {
          const a = MarkAcceptanceArgs.parse(args);
          const cur = await readIssue(root, a.id);
          const ac = [...cur.sections.acceptanceCriteria];
          if (a.index >= ac.length) {
            throw new Error(
              `acceptance index ${a.index} out of range (have ${ac.length} criteria)`,
            );
          }
          ac[a.index] = { ...ac[a.index]!, done: a.done };
          await updateIssue(root, a.id, { acceptanceCriteria: ac }, actorTag());
          await commentOnIssue(
            root,
            a.id,
            `acceptance[${a.index}] ${a.done ? "done" : "reopened"}: ${ac[a.index]!.text}`,
            actorTag(),
          );
          return jsonResult({ ok: true, criterion: ac[a.index] });
        }
        case "hive_create_issue": {
          const a = CreateIssueArgs.parse(args);
          // createIssue opts don't include `description` — only frontmatter
          // fields. If user provided description we add it via updateIssue after.
          const issue = await createIssue(root, {
            title: a.title,
            state: a.state,
            parent: a.parent,
            labels: a.labels,
          });
          if (a.description) {
            await updateIssue(root, issue.id, { description: a.description }, actorTag());
          }
          const after = await readIssue(root, issue.id);
          return jsonResult(issueToJson(after));
        }
        case "hive_delete_issue": {
          const a = DeleteIssueArgs.parse(args);
          await deleteIssue(root, a.id);
          return jsonResult({ ok: true, deleted: a.id });
        }
        case "hive_list_cycles": {
          const cycles = await listCycles(root);
          return jsonResult(cycles);
        }
        default:
          throw new Error(`unknown tool: ${name}`);
      }
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text", text: (e as Error).message }],
      };
    }
  });

  return server;
}

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

/** Who is making the change. Falls back to `agent` when run under hivemind. */
function actorTag(): string {
  return process.env.HIVE_AGENT_ID || process.env.HIVE_ACTOR || "agent";
}

/** Entry point: connect the server to stdio. Used by `hive mcp-stdio`. */
export async function runStdio(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Block forever; transport handles lifecycle.
  await new Promise<void>(() => {});
}
