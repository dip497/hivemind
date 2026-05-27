import { defineCommand } from "citty";
import path from "node:path";
import {
  HiveError,
  appendActivity,
  listCycles,
  readCycle,
  readIssue,
  requireRoot,
  writeAgentContext,
  writeCycle,
  writeIssue,
  type Cycle,
} from "@hivemind/core";
import { err, ok } from "../format.js";
import { detectWho } from "../who.js";
import { stripAt } from "../parse.js";

function normaliseCycleId(s: string): string {
  const trimmed = String(s).trim();
  if (/^cycle-\d+$/.test(trimmed)) return trimmed;
  if (/^\d+$/.test(trimmed)) return `cycle-${trimmed}`;
  return trimmed;
}

const listCyclesCmd = defineCommand({
  meta: { name: "list", description: "List cycles" },
  args: { json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const root = await requireRoot();
    const cs = await listCycles(root);
    return ok(ctx, cs, () =>
      cs.length === 0
        ? "no cycles"
        : cs
            .map((c) => `${c.id}  ${c.state.padEnd(9)}  ${c.name}  (${c.issues.length} issues)`)
            .join("\n")
    );
  },
});

const showCycleCmd = defineCommand({
  meta: { name: "show", description: "Show a cycle and its issues" },
  args: {
    id: { type: "positional", required: true },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const root = await requireRoot();
    try {
      const c = await readCycle(root, normaliseCycleId(args.id));
      return ok(ctx, c, () =>
        [
          `${c.id}  ${c.state}  ${c.name}`,
          c.start_at || c.end_at ? `dates: ${c.start_at ?? "?"} → ${c.end_at ?? "?"}` : "",
          c.issues.length ? `issues: ${c.issues.join(", ")}` : "no issues",
        ]
          .filter(Boolean)
          .join("\n")
      );
    } catch (e) {
      const msg = e instanceof HiveError ? e.message : (e as Error).message;
      const code = e instanceof HiveError ? e.code : "cycle_show_failed";
      return err(ctx, code, msg);
    }
  },
});

const newCycleCmd = defineCommand({
  meta: { name: "new", description: "Create a new cycle" },
  args: {
    id: { type: "positional", required: true, description: "Cycle id (14 or cycle-14)" },
    name: { type: "string", description: "Cycle name (default: cycle id)" },
    start: { type: "string", description: "ISO start date" },
    end: { type: "string", description: "ISO end date" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const root = await requireRoot();
    const id = normaliseCycleId(args.id);
    try {
      try {
        await readCycle(root, id);
        return err(ctx, "exists", `cycle ${id} already exists`);
      } catch {
        /* not found → ok */
      }
      const c: Cycle = {
        id,
        name: args.name ? String(args.name) : id,
        start_at: args.start ? new Date(String(args.start)).toISOString() : null,
        end_at: args.end ? new Date(String(args.end)).toISOString() : null,
        state: "upcoming",
        issues: [],
        path: path.join(root, "cycles", `${id}.md`),
        raw: "",
      };
      await writeCycle(c);
      return ok(ctx, c, () => `✓ created ${c.id}: ${c.name}`);
    } catch (e) {
      const msg = e instanceof HiveError ? e.message : (e as Error).message;
      const code = e instanceof HiveError ? e.code : "cycle_new_failed";
      return err(ctx, code, msg);
    }
  },
});

const addCycleCmd = defineCommand({
  meta: { name: "add", description: "Add an issue to a cycle" },
  args: {
    id: { type: "positional", required: true, description: "Cycle id (14)" },
    issue: { type: "positional", required: true, description: "Issue id" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const root = await requireRoot();
    try {
      const cid = normaliseCycleId(args.id);
      const iid = stripAt(String(args.issue));
      const cycle = await readCycle(root, cid);
      const issue = await readIssue(root, iid);
      if (!cycle.issues.includes(iid)) cycle.issues.push(iid);
      cycle.issues.sort();
      await writeCycle(cycle);
      if (issue.cycle !== cid) {
        appendActivity(issue, detectWho(), `cycle ${issue.cycle ?? "—"} → ${cid}`);
        issue.cycle = cid;
        await writeIssue(issue);
      }
      await writeAgentContext(root);
      return ok(ctx, { cycle: cid, issue: iid }, () => `✓ ${iid} added to ${cid}`);
    } catch (e) {
      const msg = e instanceof HiveError ? e.message : (e as Error).message;
      const code = e instanceof HiveError ? e.code : "cycle_add_failed";
      return err(ctx, code, msg);
    }
  },
});

export const cycleCmd = defineCommand({
  meta: { name: "cycle", description: "Cycle management" },
  subCommands: {
    list: listCyclesCmd,
    show: showCycleCmd,
    new: newCycleCmd,
    add: addCycleCmd,
  },
});
