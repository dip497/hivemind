/**
 * `hive statuses` — the workspace's workflow: the statuses an issue may have, each in one of the
 * six states (design jira-sync §4). Named so, not `workflow`, because `hive ctl workflow` runs
 * multi-agent workflows.
 *
 *   hive statuses show [--json]                 the statuses in board order, and the board's columns
 *   hive statuses validate [--file <f>] [--json] exit 1 with every problem, and a fix line
 *   hive statuses edit [--from <f>] [--json]     $EDITOR on workflow.yaml (or install <f>), then validate
 */
import { spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { defineCommand } from "citty";
import {
  BUILTIN_WORKFLOW, CATEGORIES, HiveError, WORKFLOW_FILE, listIssues, parseWorkflow, requireRoot, workflowStatuses, workflowView,
  type Workflow,
} from "@hivemind/core";
import { err, ok, stateColor } from "../format.js";

const jsonArg = { json: { type: "boolean" } } as const;
const fail = (ctx: { json: boolean }, e: unknown, fallback: string): never =>
  err(ctx, e instanceof HiveError ? e.code : fallback, e instanceof Error ? e.message : String(e));
const isTTY = process.stdout.isTTY;
const paint = (color: string, s: string) => (isTTY ? `${color}${s}\x1b[0m` : s);

const showCmd = defineCommand({
  meta: { name: "show", description: "List the workspace's statuses in board order, with their states" },
  args: { ...jsonArg },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const root = await requireRoot();
      const view = workflowStatuses(root);
      return ok(ctx, view, () => {
        const nameW = Math.max(...view.statuses.map((s) => s.name.length));
        const lines = [
          view.custom ? `${path.join(root, WORKFLOW_FILE)}` : `no ${WORKFLOW_FILE}: the six built-in statuses (hive statuses edit to make your own)`,
          "",
          ...view.statuses.map((s) =>
            `${paint(stateColor[s.category], s.category.padEnd(12))} ${s.name.padEnd(nameW)}  ${s.id}${s.source === "hive" && view.custom ? "  (hive only)" : ""}${s.retired ? "  (retired)" : ""}`),
        ];
        if (view.board) {
          const names = new Map(view.statuses.map((s) => [s.id, s.name]));
          lines.push("", "board columns:", ...view.board.columns.map((c) => `  ${c.name}: ${c.statuses.map((s) => names.get(s) ?? s).join(", ")}`));
        }
        return lines.join("\n");
      });
    } catch (e) {
      return fail(ctx, e, "bad_workflow");
    }
  },
});

/** Every problem with the workflow `text` would be, the issues of `root` that sit in a status it
 *  does not have among them (the board could not show them). */
async function problemsWith(root: string, text: string): Promise<{ workflow?: Workflow; problems: string[] }> {
  const { workflow, problems } = parseWorkflow(text);
  if (!workflow) return { problems };
  const ids = new Set(workflow.statuses.map((s) => s.id));
  for (const i of await listIssues(root)) {
    if (i.status && !ids.has(i.status)) problems.push(`issue ${i.id} is in status ${i.status}, which the workflow does not have (keep it, marked retired: true)`);
  }
  return problems.length ? { problems } : { workflow, problems };
}

const validateCmd = defineCommand({
  meta: { name: "validate", description: "Check workflow.yaml (or --file): exit 1 naming every problem" },
  args: { file: { type: "string", description: "a workflow file to check instead of the workspace's" }, ...jsonArg },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const root = await requireRoot();
      const file = args.file ? path.resolve(String(args.file)) : path.join(root, WORKFLOW_FILE);
      if (!existsSync(file)) {
        if (args.file) return err(ctx, "not_found", `no file ${file}`);
        return ok(ctx, { valid: true, file: null, statuses: BUILTIN_WORKFLOW.statuses.length }, () => `no ${WORKFLOW_FILE}: the six built-in statuses, nothing to check`);
      }
      const { workflow, problems } = await problemsWith(root, await fs.readFile(file, "utf8"));
      if (!workflow) {
        return err(ctx, "bad_workflow", `${file}: ${problems.join("; ")}`, undefined, `edit it (hive statuses edit) until hive statuses validate passes`);
      }
      return ok(ctx, { valid: true, file, statuses: workflow.statuses.length }, () => `✓ ${file}: ${workflow.statuses.length} statuses`);
    } catch (e) {
      return fail(ctx, e, "validate_failed");
    }
  },
});

/** What a new workflow.yaml starts as: today's six statuses, written out to be renamed and added to. */
function starter(): string {
  const lines = [
    "# The statuses an issue in this workspace may have. Each is in one of the six states",
    `# (${CATEGORIES.join(", ")}); every state needs at least one status.`,
    "# Check it with `hive statuses validate`. Design: docs/design/jira-sync-2026-10-23.md §4.",
    "version: 1",
    "statuses:",
    ...BUILTIN_WORKFLOW.statuses.map((s) => `  - { id: ${JSON.stringify(s.id)}, name: ${JSON.stringify(s.name)}, category: ${s.category} }`),
    "",
  ];
  return lines.join("\n");
}

const editCmd = defineCommand({
  meta: { name: "edit", description: "Edit workflow.yaml in $EDITOR (or install --from <file>); it is saved only once it is valid" },
  args: { from: { type: "string", description: "install this file instead of opening an editor" }, ...jsonArg },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const root = await requireRoot();
      const file = path.join(root, WORKFLOW_FILE);
      // An edit that did not validate waits in the draft, so the next edit starts from it.
      const draft = `${file}.draft`;
      if (args.from) {
        await fs.copyFile(path.resolve(String(args.from)), draft);
      } else {
        if (!existsSync(draft)) await fs.writeFile(draft, existsSync(file) ? await fs.readFile(file, "utf8") : starter());
        const editor = process.env.VISUAL || process.env.EDITOR;
        if (!editor) return err(ctx, "usage", "no $EDITOR or $VISUAL is set", undefined, `EDITOR=nano hive statuses edit, or hive statuses edit --from <file>`);
        const r = spawnSync(editor, [draft], { stdio: "inherit", shell: true });
        if (r.status !== 0) return err(ctx, "failed", `the editor exited ${r.status ?? r.signal}; your edit is kept in ${draft}`);
      }
      const { workflow, problems } = await problemsWith(root, await fs.readFile(draft, "utf8"));
      if (!workflow) {
        return err(ctx, "bad_workflow", `not saved: ${problems.join("; ")}`, undefined, `your edit is in ${draft}: run hive statuses edit again to fix it`);
      }
      await fs.rename(draft, file);
      const view = workflowView(workflow);
      return ok(ctx, { saved: file, statuses: view.statuses.length }, () => `✓ saved ${file}: ${view.statuses.length} statuses`);
    } catch (e) {
      return fail(ctx, e, "edit_failed");
    }
  },
});

export const statusesCmd = defineCommand({
  meta: { name: "statuses", description: "The workspace's statuses (workflow.yaml): show | validate | edit" },
  subCommands: { show: showCmd, validate: validateCmd, edit: editCmd },
});
