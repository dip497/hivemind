/** `hive statuses`, `hive update --status`, `hive list --status/--category` against a real temp
 *  workspace, as an agent runs them: what lands on disk, the JSON, the exit codes. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createIssue, writeConfig } from "@hivemind/core";
import { hive } from "./helpers.js";

const WORKFLOW = `version: 1
statuses:
  - { id: "jira:10000", name: Backlog, category: backlog, source: jira }
  - { id: "jira:10001", name: To Do, category: todo, source: jira }
  - { id: "jira:3", name: In Progress, category: in_progress, source: jira }
  - { id: "jira:10003", name: Code Review, category: in_review, source: jira }
  - { id: "hive:pr-created", name: PR Created, category: in_review }
  - { id: "jira:10006", name: Done, category: done, source: jira }
  - { id: "jira:10007", name: Won't Do, category: cancelled, source: jira }
`;
const BROKEN = WORKFLOW.replace(/.*Won't Do.*\n/, "");

/** Each test runs several real `hive` processes: on a loaded machine that is more than 5 s. */
const SLOW = 60_000;
const dirs: string[] = [];
let xdg: string;
const env = () => ({ XDG_CONFIG_HOME: xdg, HIVE_AGENT_ID: "tester" });
async function workspace(workflow?: string): Promise<{ ws: string; root: string }> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hive-statuses-"));
  dirs.push(ws);
  const root = path.join(ws, ".hivemind");
  await fs.mkdir(path.join(root, "issues"), { recursive: true });
  await writeConfig(root, { prefix: "TT", next_id: 1, agents: {} } as never);
  if (workflow) await fs.writeFile(path.join(root, "workflow.yaml"), workflow);
  return { ws, root };
}
const run = (ws: string, ...args: string[]) => hive([...args, "--json"], { cwd: ws, env: env() });
beforeAll(async () => { xdg = await fs.mkdtemp(path.join(os.tmpdir(), "hive-statuses-xdg-")); dirs.push(xdg); });
afterAll(async () => { for (const d of dirs) await fs.rm(d, { recursive: true, force: true }); });

describe("with no workflow.yaml", () => {
  test("show lists the six states as statuses; list and update are as they were", async () => {
    const { ws, root } = await workspace();
    await createIssue(root, { title: "a" });
    const shown = run(ws, "statuses", "show");
    expect(shown.code).toBe(0);
    expect(shown.json).toMatchObject({ custom: false });
    expect((shown.json as { statuses: { id: string }[] }).statuses.map((s) => s.id)).toEqual(["backlog", "todo", "in_progress", "in_review", "done", "cancelled"]);
    const listed = run(ws, "list", "--status", "todo");
    expect((listed.json as { issues: object[] }).issues).toEqual([expect.not.objectContaining({ statusName: expect.anything() })]);
    expect(run(ws, "update", "TT-1", "--status", "in_review").json).toMatchObject({ state: "in_review" });
    expect(await fs.readFile(path.join(root, "issues", "TT-1.md"), "utf8")).not.toContain("status:");
    expect(run(ws, "statuses", "validate").code).toBe(0);
  }, SLOW);
});

describe("with a workflow.yaml", () => {
  test("update --status moves to a status by name and the state follows; an unknown one is refused", async () => {
    const { ws, root } = await workspace(WORKFLOW);
    await createIssue(root, { title: "a" });
    const moved = run(ws, "update", "TT-1", "--status", "code review");
    expect(moved.code).toBe(0);
    expect(moved.json).toMatchObject({ state: "in_review", status: "jira:10003" });
    const refused = run(ws, "update", "TT-1", "--status", "Shipped");
    expect(refused.code).toBe(1);
    expect(refused.json).toMatchObject({ error: { code: "INVALID_ARG", message: expect.stringContaining("Code Review (jira:10003)") } });
    expect(run(ws, "update", "TT-1", "--status", "Done", "--state", "done").code).toBe(2);
  }, SLOW);

  test("list filters by status and category, and each issue names its status", async () => {
    const { ws, root } = await workspace(WORKFLOW);
    await createIssue(root, { title: "a", status: "PR Created" });
    await createIssue(root, { title: "b", status: "Code Review" });
    await createIssue(root, { title: "c" });
    const ids = (...args: string[]) => (run(ws, "list", ...args).json as { issues: { id: string }[] }).issues.map((i) => i.id);
    expect(ids("--status", "pr created")).toEqual(["TT-1"]);
    expect(ids("--category", "in_review")).toEqual(["TT-1", "TT-2"]);
    const all = (run(ws, "list").json as { issues: { id: string; statusName: string }[] }).issues;
    expect(all.map((i) => i.statusName)).toEqual(["PR Created", "Code Review", "To Do"]);
    expect(run(ws, "list", "--status", "Nope").json).toMatchObject({ error: { code: "BAD_STATUS" } });
  }, SLOW);

  test("validate exits 1 naming each problem and the fix; an issue in a status the file lacks is one", async () => {
    const { ws, root } = await workspace(WORKFLOW);
    expect(run(ws, "statuses", "validate").json).toMatchObject({ valid: true, statuses: 7 });
    await fs.writeFile(path.join(root, "workflow.yaml"), BROKEN);
    const bad = run(ws, "statuses", "validate");
    expect(bad.code).toBe(1);
    expect(bad.json).toMatchObject({ error: { code: "BAD_WORKFLOW", message: expect.stringContaining("category cancelled has no status"), fix: expect.stringContaining("hive statuses edit") } });
    await fs.writeFile(path.join(root, "workflow.yaml"), WORKFLOW);
    await createIssue(root, { title: "a", status: "Done" });
    const dropped = path.join(ws, "dropped.yaml");
    await fs.writeFile(dropped, WORKFLOW.replace("Done, category: done", "Shipped, category: done").replace("jira:10006", "jira:20000"));
    expect(run(ws, "statuses", "validate", "--file", dropped).json).toMatchObject({ error: { message: expect.stringContaining("issue TT-1 is in status jira:10006") } });
  }, SLOW);

  test("edit saves only a valid workflow; an invalid edit waits in the draft and the file stays", async () => {
    const { ws, root } = await workspace();
    const file = path.join(root, "workflow.yaml");
    const broken = path.join(ws, "broken.yaml");
    await fs.writeFile(broken, BROKEN);
    const refused = run(ws, "statuses", "edit", "--from", broken);
    expect(refused.code).toBe(1);
    await expect(fs.stat(file)).rejects.toThrow();
    expect(await fs.readFile(`${file}.draft`, "utf8")).toBe(BROKEN);
    // The next edit starts from the draft: an editor that adds the missing status saves it.
    const editor = `sh -c 'echo "  - { id: wont, name: Wont, category: cancelled }" >> "$0"'`;
    const saved = hive(["statuses", "edit", "--json"], { cwd: ws, env: { ...env(), EDITOR: editor, VISUAL: "" } });
    expect(saved.code).toBe(0);
    expect(await fs.readFile(file, "utf8")).toBe(`${BROKEN}  - { id: wont, name: Wont, category: cancelled }\n`);
    await expect(fs.stat(`${file}.draft`)).rejects.toThrow();
    expect((run(ws, "statuses", "show").json as { statuses: unknown[] }).statuses).toHaveLength(7);
  }, SLOW);
});
