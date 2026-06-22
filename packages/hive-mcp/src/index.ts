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
import pkg from "../package.json" with { type: "json" };
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
  linkIssues,
  listIssues,
  listWorkspaces,
  prefixOf,
  readConfig,
  readIssue,
  registerWorkspace,
  resolveWorkspaceByPrefix,
  transferIssue,
  updateIssue,
  IssueStateZ,
  LinkTypeZ,
  type Issue,
  type IssueState,
} from "@hivemind/core";
import type { IssuePatch } from "@hivemind/core/storage";
import { hcpCall } from "./hcp-client.js";

/** Resolve the repo root from $HIVE_ROOT (set by `hive mcp-stdio --root`)
 *  or by walking up from cwd. Throws if no .hivemind found. Also registers
 *  the workspace so cross-repo tools elsewhere can resolve its prefix. */
async function resolveRoot(): Promise<string> {
  const envRoot = process.env.HIVE_ROOT;
  const root = envRoot ?? (await findRoot(process.cwd()));
  if (!root) {
    throw new Error(
      "no .hivemind found — set HIVE_ROOT env var or run from a repo with `.hivemind/` at or above cwd",
    );
  }
  await registerWorkspace(root).catch(() => {});
  return root;
}

/** Resolve which workspace root owns `id`. If the id's prefix matches the
 *  local workspace, returns `localRoot`; otherwise resolves the owning repo via
 *  the registry — letting every tool operate on issues in OTHER repos by id
 *  alone. Throws a clear error when the foreign workspace isn't registered. */
async function rootForId(localRoot: string, id: string): Promise<string> {
  const prefix = prefixOf(id);
  if (!prefix) return localRoot; // malformed → let readIssue throw a clean error
  const localPrefix = (await readConfig(localRoot)).prefix;
  if (prefix === localPrefix) return localRoot;
  const ws = await resolveWorkspaceByPrefix(prefix);
  if (!ws) {
    throw new Error(
      `issue ${id} belongs to workspace '${prefix}', which isn't registered — open it in hivemind once, or run \`hive workspace register\` in that repo`,
    );
  }
  return ws.root;
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
    created: i.created,
    updated: i.updated,
    links: i.links ?? [],
    description: i.sections.description,
    acceptanceCriteria: i.sections.acceptanceCriteria,
    activity: i.sections.activity,
  };
}

const TOOLS: Tool[] = [
  {
    name: "hive_get_issue",
    description:
      "Get a single issue by id (e.g. 'PAY-42'). Works cross-repo: an id whose prefix belongs to another registered workspace is resolved automatically. Returns title, state, description, acceptance criteria, recent activity, labels, assignee, and cross-repo links.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Issue id like 'PAY-42'" } },
      required: ["id"],
    },
  },
  {
    name: "hive_list_issues",
    description:
      "List issues in a workspace. Optionally filter by state, label, or assignee. Pass `workspace` (a prefix like 'OPS') to list issues in ANOTHER registered repo; omit it for the current workspace. Returns lightweight summaries (no body).",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          enum: ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"],
        },
        label: { type: "string" },
        assignee: { type: "string", description: "assignee id (agent or member id)" },
        workspace: {
          type: "string",
          description: "Workspace prefix to list (e.g. 'OPS'). Omit for the current repo.",
        },
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
      "Patch an issue's fields: title, description, labels, assignee, parent. For state changes use hive_set_state instead.",
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
      "Create a new issue. Returns the new issue with allocated id. Use for sub-tasks discovered during work. Put acceptance criteria in `acceptance_criteria` (a string array), NOT inside `description` — that keeps them in the dedicated checklist you can later tick with hive_mark_acceptance.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        parent: { type: "string", description: "parent issue id for sub-tasks" },
        labels: { type: "array", items: { type: "string" } },
        acceptance_criteria: {
          type: "array",
          items: { type: "string" },
          description: "Acceptance criteria, one per item — kept as a structured checklist.",
        },
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
    name: "hive_list_workspaces",
    description:
      "List every registered hivemind workspace (other repos) with its prefix, title, and path. Use this to discover which repos you can move issues to or link against in a multi-repo setup.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "hive_move_issue",
    description:
      "Transfer an issue into another workspace (by destination prefix). mode 'move' deletes the source and stamps the new issue 'moved-from'; mode 'copy' keeps the source and links both with 'relates'. Refuses to move an issue that has sub-issues. Returns the new id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Source issue id (in the current or any registered repo)" },
        to_workspace: { type: "string", description: "Destination workspace prefix, e.g. 'OPS'" },
        mode: { type: "string", enum: ["move", "copy"], description: "default 'move'" },
      },
      required: ["id", "to_workspace"],
    },
  },
  {
    name: "hive_link_issue",
    description:
      "Create a cross-repo (or intra-repo non-parent) link between two issues by id. The reciprocal is recorded on the other end automatically (blocks↔blocked-by, parent-of↔child-of; relates/duplicates are symmetric). For the single-repo parent hierarchy use hive_update_issue's `parent` instead.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Source issue id" },
        other_id: { type: "string", description: "Target issue id (any registered workspace)" },
        type: {
          type: "string",
          enum: ["relates", "blocks", "blocked-by", "duplicates", "parent-of", "child-of"],
          description: "default 'relates'",
        },
      },
      required: ["id", "other_id"],
    },
  },
  // ── canvas / agent control (HCP — needs the desktop app running) ──────────
  {
    name: "hive_spawn_agent",
    description:
      "Spawn a NEW coding agent as a tile on the hivemind canvas and hand it a prompt. Returns its tileId. Use this to delegate a subtask to a sibling agent. By DEFAULT the worker AUTO-REPORTS: when it finishes its turn, its reply is delivered straight back into YOUR session (you'll see a '[hive] from <tileId>:' message) — so you can fire-and-forget and keep working, no need to block on hive_read. A visible reporting edge is drawn from the worker to you. Pass `supervise` to have the worker escalate its tool-permission prompts to YOU (you'll get a '[hive] APPROVAL …' message and answer with hive_approve) instead of stopping for a human — so it can run unattended under your watch. Use hive_send for a follow-up turn, or hive_read only to synchronously block for the next reply. Requires the hivemind desktop app to be running.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Agent to launch: 'claude' (default), 'codex', 'opencode', 'droid', …" },
        prompt: { type: "string", description: "Initial task delivered once the agent is ready." },
        frame: { type: "string", description: "Frame to spawn into — a frame id, repo/worktree name, or title (e.g. 'manageark'). Omit to use the spawning agent's own frame. Discover with hive_list_frames." },
        mode: { type: "string", description: "claude permission mode (e.g. 'plan', 'acceptEdits'); optional." },
        report: { type: "boolean", description: "Auto-deliver the worker's replies back to you when it finishes a turn (default true). Set false for a fire-and-forget worker you'll poll with hive_read instead." },
        supervise: { description: "Route the worker's tool-permission prompts to YOU (the spawner) to approve via hive_approve, instead of a human. true / 'parent' brokers the mutating tools (Bash/Edit/Write/WebFetch); 'all' brokers every tool; or pass a comma-string / array of tool names. Omit for normal (human) permissions. Fails safe to the human prompt if you don't answer.", type: ["boolean", "string", "array"], items: { type: "string" } },
      },
    },
  },
  {
    name: "hive_send",
    description:
      "Send text to an agent tile (by tileId from hive_spawn_agent) — like typing into its terminal and pressing Enter. Use for follow-up turns in a conversation with a spawned agent. Requires the hivemind desktop app.",
    inputSchema: {
      type: "object",
      properties: {
        tileId: { type: "string" },
        text: { type: "string" },
        submit: { type: "boolean", description: "Press Enter after the text (default true)." },
      },
      required: ["tileId", "text"],
    },
  },
  {
    name: "hive_send_keys",
    description:
      "Send a sequence of KEYS to an agent tile's terminal UI — for driving an interactive TUI you can't answer with plain text, e.g. selecting an option in a worker's native AskUserQuestion picker. Pass `keys` as an array of tokens: arrows 'Up'/'Down'/'Left'/'Right', 'Enter', 'Esc', 'Tab', 'Space', 'Backspace', 'Home'/'End'/'PageUp'/'PageDown', or any literal text/digits (sent as-is). They're emitted with a small gap so the TUI registers each. Example: to pick the 2nd option in a picker, keys: [\"Down\", \"Enter\"]. Requires the hivemind desktop app.",
    inputSchema: {
      type: "object",
      properties: {
        tileId: { type: "string" },
        keys: { type: "array", items: { type: "string" }, description: "Ordered key tokens, e.g. [\"Down\",\"Enter\"]." },
      },
      required: ["tileId", "keys"],
    },
  },
  {
    name: "hive_read",
    description:
      "OPTIONAL synchronous read: block until a spawned agent (by tileId) finishes its current turn, then return its reply (its final assistant message, read cleanly from the session transcript — never screen-scraped). Most of the time you DON'T need this — agents spawned with report:true (the default) auto-deliver their replies into your session when done. Use hive_read only when you must block for the answer inline. On timeout it returns finalStatus:'timeout' (the agent is still working) — it does NOT return raw terminal output. Requires the hivemind desktop app.",
    inputSchema: {
      type: "object",
      properties: {
        tileId: { type: "string" },
        timeout_ms: { type: "number", description: "Max wait in ms (default 120000)." },
      },
      required: ["tileId"],
    },
  },
  {
    name: "hive_approve",
    description:
      "Answer an approval request from a supervised worker (spawned with `supervise`). When a worker wants to run a brokered tool you'll get a '[hive] APPROVAL — worker <id> wants to run <tool>: <summary>\\nReply: hive_approve(\"<reqId>\", …)' message; call this with that reqId. decision: 'allow'/'deny' for this one call, or 'always'/'never' to also remember the decision for that worker+tool (no more prompts for it). Requires the hivemind desktop app.",
    inputSchema: {
      type: "object",
      properties: {
        reqId: { type: "string", description: "The approval request id from the '[hive] APPROVAL …' message." },
        decision: { type: "string", enum: ["allow", "deny", "always", "never"], description: "allow/deny this call; always/never also remember it for this worker+tool." },
        reason: { type: "string", description: "Optional note shown to the worker (especially useful on deny, so it can adapt)." },
      },
      required: ["reqId", "decision"],
    },
  },
  {
    name: "hive_list_frames",
    description:
      "List the canvas frames (workspaces) — each with its id, title, repo/worktree path, branch, and tile count. Use to discover which frame to spawn into (pass its id, repo name, or title as hive_spawn_agent's `frame`). Requires the hivemind desktop app.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "hive_list_tiles",
    description:
      "List the tiles on the hivemind canvas GROUPED BY FRAME — returns { frames: [{ frameId, title, repo, branch, tiles: [{ tileId, kind, label, status }] }], loose: [...] }. Each agent tile carries its live status (working/idle/blocked/…). Pass `frame` to filter to a single frame (by id, repo name, or title); omit to list every frame. Use to discover spawned agents and check whether they're busy. Requires the hivemind desktop app.",
    inputSchema: { type: "object", properties: { frame: { type: "string", description: "Filter to one frame — a frame id, repo name, or title. Omit to list all frames." } } },
  },
  {
    name: "hive_focus",
    description: "Focus a tile on the canvas (select it and bring it into view) by tileId. Requires the hivemind desktop app.",
    inputSchema: { type: "object", properties: { tileId: { type: "string" } }, required: ["tileId"] },
  },
  {
    name: "hive_close_tile",
    description: "Close a tile by tileId (e.g. shut down a worker agent you spawned). Requires the hivemind desktop app.",
    inputSchema: { type: "object", properties: { tileId: { type: "string" } }, required: ["tileId"] },
  },
  {
    name: "hive_open_review",
    description:
      "Open a plan in hivemind's visual review tile and BLOCK until the human approves or requests changes. Returns { decision: 'allow'|'deny', feedback? }. Use to get human sign-off on a plan you generated before acting on it. Requires the hivemind desktop app.",
    inputSchema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "The plan markdown to review." },
        cwd: { type: "string", description: "Working directory for context (shown in the tile)." },
      },
      required: ["plan"],
    },
  },
  {
    name: "hive_report",
    description:
      "Report a result back to the agent that SPAWNED you (your parent). If you were launched by another agent via hive_spawn_agent, call this when you finish your delegated task — your message is delivered into the parent's session so it can collect your findings without polling. No-op error if you have no parent. Requires the hivemind desktop app.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", description: "Your result/findings to send to the parent agent." } },
      required: ["message"],
    },
  },
  {
    name: "hive_connect",
    description:
      "Pipe one agent's output into another's input: whenever the source agent (src_tile_id) finishes a turn, its reply is automatically sent to the destination agent (dst_tile_id). Chains workers without you relaying messages by hand. Requires the hivemind desktop app.",
    inputSchema: {
      type: "object",
      properties: { src_tile_id: { type: "string" }, dst_tile_id: { type: "string" } },
      required: ["src_tile_id", "dst_tile_id"],
    },
  },
  {
    name: "hive_disconnect",
    description: "Remove a pipe created by hive_connect. Omit dst_tile_id to remove all pipes from src_tile_id. Requires the hivemind desktop app.",
    inputSchema: {
      type: "object",
      properties: { src_tile_id: { type: "string" }, dst_tile_id: { type: "string" } },
      required: ["src_tile_id"],
    },
  },
  {
    name: "hive_workflow",
    description:
      "Run a MULTI-AGENT WORKFLOW: spawn a fleet of worker agents as VISIBLE tiles on the canvas, drive them, and BLOCK until they're done — then return their replies aggregated, in one call. This is hivemind's native answer to fanning work out (no hand-rolling spawn→read→gather across many tool calls). Workers are real tiles you and the user watch; each is a child of you (the orchestrator), depth-capped and rate-limited. Pick a `shape`:\n• 'fanout' — one worker per `items[i]`, all run in parallel (bounded by `max_concurrent`); `prompt` is a template with a `{item}` placeholder filled per worker. Returns each worker's reply. Use for: review N files, summarize N docs, try N approaches.\n• 'mapreduce' — a fanout, then ONE reducer agent fed all worker outputs via `reduce_prompt` (use `{results}` for the joined outputs). Returns the workers + the reducer's synthesis.\n• 'pipeline' — a sequential chain: `stages` is an array of prompts, each may use `{input}` to reference the PRIOR stage's reply. Returns each step + the final output.\nFor dynamic control flow a fixed shape can't express (loop-until-done, judge panels, conditional fan-out), drive `hive_spawn_agent`/`hive_read`/`hive_connect` yourself instead (see the hive-workflow skill). Requires the hivemind desktop app.",
    inputSchema: {
      type: "object",
      properties: {
        shape: { type: "string", enum: ["fanout", "pipeline", "mapreduce"], description: "fanout (parallel, one per item) | pipeline (sequential chain) | mapreduce (fanout + reducer)." },
        items: { type: "array", items: { type: "string" }, description: "fanout/mapreduce: one worker spawned per element. Substituted into `prompt`'s {item}." },
        prompt: { type: "string", description: "fanout/mapreduce: the per-worker task. Use {item} as the placeholder for each element of `items`." },
        stages: { type: "array", items: { type: "string" }, description: "pipeline: one prompt per stage, run in order. Each may use {input} to reference the prior stage's reply." },
        input: { type: "string", description: "pipeline: optional seed value substituted into the FIRST stage's {input}." },
        reduce_prompt: { type: "string", description: "mapreduce: the reducer agent's prompt. Use {results} for all worker outputs joined together." },
        agent: { type: "string", description: "Runtime for every worker: 'claude' (default), 'codex', 'droid', … " },
        frame: { type: "string", description: "Frame to spawn workers into. Omit to use your own frame. Discover with hive_list_frames." },
        supervise: { description: "Broker the workers' tool-permission prompts to YOU (answer with hive_approve) instead of a human — for unattended fan-out. true brokers the mutating tools; 'all' brokers every tool; or a comma-string / array of tool names.", type: ["boolean", "string", "array"], items: { type: "string" } },
        max_concurrent: { type: "integer", minimum: 1, description: "Max workers live at once for fanout/mapreduce (default 6, capped at 12)." },
        timeout_ms: { type: "number", description: "Per-worker turn ceiling in ms (default 600000)." },
        close_when_done: { type: "boolean", description: "Close each worker tile after collecting its reply (default false — leave them on the canvas to inspect)." },
      },
      required: ["shape"],
    },
  },
];

const GetIssueArgs = z.object({ id: z.string() });
const ListIssuesArgs = z.object({
  state: IssueStateZ.optional(),
  label: z.string().optional(),
  assignee: z.string().optional(),
  workspace: z.string().optional(),
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
  acceptance_criteria: z.array(z.string()).optional(),
  state: IssueStateZ.optional(),
});
const DeleteIssueArgs = z.object({ id: z.string() });
const MoveIssueArgs = z.object({
  id: z.string(),
  to_workspace: z.string(),
  mode: z.enum(["move", "copy"]).default("move"),
});
const LinkIssueArgs = z.object({
  id: z.string(),
  other_id: z.string(),
  type: LinkTypeZ.default("relates"),
});
const SpawnAgentArgs = z.object({
  agent: z.string().optional(),
  prompt: z.string().optional(),
  frame: z.string().optional(),
  mode: z.string().optional(),
  report: z.boolean().optional(),
  supervise: z.union([z.boolean(), z.string(), z.array(z.string())]).optional(),
});
const ApproveArgs = z.object({
  reqId: z.string(),
  decision: z.enum(["allow", "deny", "always", "never"]),
  reason: z.string().optional(),
});
const SendArgs = z.object({ tileId: z.string(), text: z.string(), submit: z.boolean().optional() });
const SendKeysArgs = z.object({ tileId: z.string(), keys: z.array(z.string()).min(1) });
const ReadArgs = z.object({ tileId: z.string(), timeout_ms: z.number().optional() });
const TileIdArgs = z.object({ tileId: z.string() });
const OpenReviewArgs = z.object({ plan: z.string().min(1), cwd: z.string().optional() });
const ConnectArgs = z.object({ src_tile_id: z.string(), dst_tile_id: z.string() });
const DisconnectArgs = z.object({ src_tile_id: z.string(), dst_tile_id: z.string().optional() });
const WorkflowArgs = z.object({
  shape: z.enum(["fanout", "pipeline", "mapreduce"]),
  items: z.array(z.string()).optional(),
  prompt: z.string().optional(),
  stages: z.array(z.string()).optional(),
  input: z.string().optional(),
  reduce_prompt: z.string().optional(),
  agent: z.string().optional(),
  frame: z.string().optional(),
  supervise: z.union([z.boolean(), z.string(), z.array(z.string())]).optional(),
  max_concurrent: z.number().int().positive().optional(),
  timeout_ms: z.number().positive().optional(),
  close_when_done: z.boolean().optional(),
});

/** Build and return an MCP Server bound to hive-core. Caller transports it. */
export function buildServer(): Server {
  const server = new Server(
    { name: "hive", version: pkg.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  // Canvas/agent tools drive the running app over HCP and need NO issue
  // workspace — only the issue tools resolve a `.hivemind/` root. Resolving it
  // for canvas tools would (wrongly) fail in a repo without `.hivemind/`.
  const CANVAS_TOOLS = new Set([
    "hive_spawn_agent", "hive_send", "hive_send_keys", "hive_read", "hive_approve", "hive_list_frames", "hive_list_tiles",
    "hive_focus", "hive_close_tile", "hive_connect", "hive_disconnect", "hive_open_review",
    "hive_report", "hive_workflow",
  ]);
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const root = CANVAS_TOOLS.has(name) ? "" : await resolveRoot();
    try {
      switch (name) {
        case "hive_get_issue": {
          const { id } = GetIssueArgs.parse(args);
          const issue = await readIssue(await rootForId(root, id), id);
          return jsonResult(issueToJson(issue));
        }
        case "hive_list_issues": {
          const a = ListIssuesArgs.parse(args ?? {});
          // `workspace` (a prefix) lists ANOTHER registered repo's issues.
          let listRoot = root;
          if (a.workspace) {
            const ws = await resolveWorkspaceByPrefix(a.workspace.toUpperCase());
            if (!ws) throw new Error(`no registered workspace with prefix '${a.workspace}'`);
            listRoot = ws.root;
          }
          const all = await listIssues(listRoot);
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
          const r = await rootForId(root, a.id);
          // updateIssue already appends a state-change activity row internally.
          // We only add an extra comment when the user supplied a note (avoids
          // duplicate "state: todo → in_progress" entries in the activity log).
          await updateIssue(r, a.id, { state: a.state as IssueState }, actorTag());
          if (a.note) {
            await commentOnIssue(r, a.id, a.note, actorTag());
          }
          const after = await readIssue(r, a.id);
          return jsonResult(issueToJson(after));
        }
        case "hive_add_comment": {
          const a = AddCommentArgs.parse(args);
          const r = await rootForId(root, a.id);
          // Signature: commentOnIssue(root, id, message, who?).
          await commentOnIssue(r, a.id, a.message, actorTag());
          const after = await readIssue(r, a.id);
          return jsonResult({ ok: true, activity: after.sections.activity.slice(-3) });
        }
        case "hive_update_issue": {
          const a = UpdateIssueArgs.parse(args);
          const r = await rootForId(root, a.id);
          const patch: IssuePatch = {};
          if (a.title !== undefined) patch.title = a.title;
          if (a.description !== undefined) patch.description = a.description;
          if (a.labels !== undefined) patch.labels = a.labels;
          if (a.assignee !== undefined) patch.assignee = a.assignee;
          // IssuePatch uses `undefined` (not null) to mean "clear"; map both.
          if (a.parent !== undefined) patch.parent = a.parent ?? undefined;
          await updateIssue(r, a.id, patch, actorTag());
          const after = await readIssue(r, a.id);
          return jsonResult(issueToJson(after));
        }
        case "hive_mark_acceptance": {
          const a = MarkAcceptanceArgs.parse(args);
          const r = await rootForId(root, a.id);
          const cur = await readIssue(r, a.id);
          const ac = [...cur.sections.acceptanceCriteria];
          if (a.index >= ac.length) {
            throw new Error(
              `acceptance index ${a.index} out of range (have ${ac.length} criteria)`,
            );
          }
          ac[a.index] = { ...ac[a.index]!, done: a.done };
          await updateIssue(r, a.id, { acceptanceCriteria: ac }, actorTag());
          await commentOnIssue(
            r,
            a.id,
            `acceptance[${a.index}] ${a.done ? "done" : "reopened"}: ${ac[a.index]!.text}`,
            actorTag(),
          );
          return jsonResult({ ok: true, criterion: ac[a.index] });
        }
        case "hive_create_issue": {
          const a = CreateIssueArgs.parse(args);
          // Sub-issues must be created in the same repo as their parent; a plain
          // issue lands in the current workspace.
          const r = a.parent ? await rootForId(root, a.parent) : root;
          const issue = await createIssue(r, {
            title: a.title,
            state: a.state,
            parent: a.parent,
            labels: a.labels,
            description: a.description,
            acceptanceCriteria: a.acceptance_criteria?.map((text) => ({ done: false, text })),
          });
          const after = await readIssue(r, issue.id);
          return jsonResult(issueToJson(after));
        }
        case "hive_delete_issue": {
          const a = DeleteIssueArgs.parse(args);
          await deleteIssue(await rootForId(root, a.id), a.id);
          return jsonResult({ ok: true, deleted: a.id });
        }
        case "hive_list_workspaces": {
          const ws = await listWorkspaces({ persistPrune: true });
          return jsonResult(
            ws.map((w) => ({ prefix: w.prefix, title: w.title, repo: w.repo })),
          );
        }
        case "hive_move_issue": {
          const a = MoveIssueArgs.parse(args);
          const r = await rootForId(root, a.id);
          const res = await transferIssue(r, a.id, a.to_workspace.toUpperCase(), {
            mode: a.mode,
            actor: actorTag(),
          });
          return jsonResult({ ok: true, mode: res.mode, from: res.from, newId: res.newId });
        }
        case "hive_link_issue": {
          const a = LinkIssueArgs.parse(args);
          const r = await rootForId(root, a.id);
          const res = await linkIssues(r, a.id, a.other_id, a.type, actorTag());
          return jsonResult({ ok: true, ...res });
        }
        case "hive_spawn_agent": {
          const a = SpawnAgentArgs.parse(args);
          // Default the new agent into THIS agent's frame (its own tile id is in
          // the env hivemind injected). The renderer resolves the frame.
          return jsonResult(await hcpCall("tile.spawn_agent", { ...a, callerTile: process.env.HIVEMIND_TILE }));
        }
        case "hive_send": {
          const a = SendArgs.parse(args);
          return jsonResult(await hcpCall("agent.send", a));
        }
        case "hive_send_keys": {
          const a = SendKeysArgs.parse(args);
          return jsonResult(await hcpCall("agent.send_keys", a));
        }
        case "hive_read": {
          const a = ReadArgs.parse(args);
          // Give the wire client a ceiling ABOVE the server-side read timeout, or
          // long reads die at the client's default 130s before the read returns.
          const readMs = a.timeout_ms ?? 120_000;
          return jsonResult(await hcpCall("agent.read", { tileId: a.tileId, timeoutMs: readMs }, readMs + 15_000));
        }
        case "hive_approve": {
          const a = ApproveArgs.parse(args);
          return jsonResult(await hcpCall("agent.approve", a));
        }
        case "hive_list_frames":
          return jsonResult(await hcpCall("tile.list_frames", {}));
        case "hive_list_tiles": {
          const a = z.object({ frame: z.string().optional() }).parse(args);
          return jsonResult(await hcpCall("tile.list", { frame: a.frame }));
        }
        case "hive_focus": {
          const a = TileIdArgs.parse(args);
          return jsonResult(await hcpCall("tile.focus", { tileId: a.tileId }));
        }
        case "hive_close_tile": {
          const a = TileIdArgs.parse(args);
          return jsonResult(await hcpCall("tile.close", { tileId: a.tileId }));
        }
        case "hive_open_review": {
          const a = OpenReviewArgs.parse(args);
          // Human review can take minutes — give the round-trip a long ceiling.
          return jsonResult(await hcpCall("review.open", { plan: a.plan, cwd: a.cwd }, 24 * 60 * 60 * 1000));
        }
        case "hive_report": {
          const a = z.object({ message: z.string().min(1) }).parse(args);
          return jsonResult(await hcpCall("agent.report", { callerTile: process.env.HIVEMIND_TILE, message: a.message }));
        }
        case "hive_connect": {
          const a = ConnectArgs.parse(args);
          return jsonResult(await hcpCall("tile.connect", { srcTileId: a.src_tile_id, dstTileId: a.dst_tile_id }));
        }
        case "hive_disconnect": {
          const a = DisconnectArgs.parse(args);
          return jsonResult(await hcpCall("tile.disconnect", { srcTileId: a.src_tile_id, dstTileId: a.dst_tile_id }));
        }
        case "hive_workflow": {
          const a = WorkflowArgs.parse(args);
          // A workflow runs many worker turns; the orchestrator's tool call must
          // block for the whole fleet. Give the wire client a ceiling ABOVE the
          // worst-case server-side run (workers are concurrent, so summing the
          // per-worker timeout over every item/stage is a safe over-estimate),
          // capped so a runaway can't hang the connection forever.
          const perTurn = a.timeout_ms ?? 600_000;
          const units = (a.items?.length ?? 0) + (a.stages?.length ?? 0) + 2;
          const ceiling = Math.min(24 * 60 * 60 * 1000, perTurn * units + 30_000);
          return jsonResult(await hcpCall("workflow.run", { ...a, callerTile: process.env.HIVEMIND_TILE }, ceiling));
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
