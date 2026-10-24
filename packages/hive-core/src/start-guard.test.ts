// The start-work guard (design jira-sync §10), one row per check, on issues mirrored the way the
// Jira service mirrors them: records made from the Cloud fixture site and written through ingest.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingestRecords } from "./ingest.js";
import { createIssue, readIssue, writeConfig, writeIssue } from "./storage.js";
import { checkStartWork, registerStartWorkProvider, unacknowledged, type StartCheck, type StartContext, type StartFinding } from "./start-guard.js";
import type { Issue } from "./types.js";

const SOURCE = "jira:acme/PAY";
const site = JSON.parse(readFileSync(path.join(import.meta.dir, "../../jira-fake/fixtures/cloud-scrum-company.site.json"), "utf8"));

type SiteIssue = { id: string; key: string; issueType: string; status: string; summary: string; assignee: string | null; parent?: string; sprints?: number[]; labels?: string[]; flagged?: boolean; links?: unknown[]; properties?: { hivemind?: { by: string; branch: string } }; updated: string };
const CATEGORY: Record<string, string> = { new: "todo", indeterminate: "in_progress", done: "done" };

/** A fixture issue as the Jira service hands it to ingest (design §6.4's mapping). */
function recordOf(key: string, over: { status?: string; permissions?: string[] } = {}): Record<string, unknown> {
  const i = (site.issues as SiteIssue[]).find((x) => x.key === key)!;
  const st = (site.statuses as { id: string; name: string; statusCategory: { key: string } }[]).find((s) => s.id === (over.status ?? i.status))!;
  const user = (site.users as { accountId: string; displayName: string }[]).find((u) => u.accountId === i.assignee);
  const sprintId = i.sprints?.at(-1);
  const sprint = sprintId === undefined ? null : (site.sprints as { id: number; name: string; state: string }[]).find((s) => s.id === sprintId)!;
  const claim = i.properties?.hivemind;
  return {
    external: {
      id: i.id, key: i.key, type: { id: i.issueType, name: "Story" }, remoteUpdated: i.updated,
      assignee: user ? { accountId: user.accountId, name: user.displayName, me: user.accountId === site.myself } : null,
      sprint: sprint && { id: sprint.id, name: sprint.name, state: sprint.state },
      ...(i.parent ? { parentKey: i.parent } : {}),
      ...(i.links ? { links: i.links } : {}),
      ...(claim ? { claimedBy: { by: claim.by, branch: claim.branch } } : {}),
      ...(over.permissions ? { permissions: over.permissions } : {}),
    },
    title: i.summary,
    status: { id: `jira:${st.id}`, name: st.name, category: CATEGORY[st.statusCategory.key] },
    labels: [...(i.labels ?? []), ...(i.flagged ? ["flagged"] : [])],
  };
}

let xdg: string;
beforeAll(async () => {
  xdg = await fs.mkdtemp(path.join(os.tmpdir(), "hive-guard-xdg-"));
  process.env.XDG_CONFIG_HOME = xdg; // ingest registers PAY in this registry
});
afterAll(() => fs.rm(xdg, { recursive: true, force: true }));

async function mkRoot(): Promise<string> {
  const root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "hive-guard-")), ".hivemind");
  await fs.mkdir(path.join(root, "issues"), { recursive: true });
  await writeConfig(root, { prefix: "HIVE", next_id: 1, agents: {} });
  return root;
}

const checksOf = (findings: StartFinding[]) => findings.map((f) => f.check);
const ctx: StartContext = { actor: "test" };

describe("checkStartWork on mirrored Cloud issues", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkRoot();
    await ingestRecords(root, SOURCE, [
      recordOf("PAY-318"), recordOf("PAY-321"), recordOf("PAY-325"), recordOf("PAY-328"), recordOf("PAY-326"), recordOf("PAY-329"),
      // The sub-task's parent is done in this row.
      recordOf("PAY-322", { status: "10006" }), recordOf("PAY-323"),
      recordOf("PAY-324"), recordOf("PAY-330"), recordOf("PAY-327", { permissions: ["BROWSE_PROJECTS", "ASSIGNABLE_USER"] }),
    ]);
  });

  const rows: { check: StartCheck; key: string; severity: StartFinding["severity"]; actions: string[]; target?: string; ctx?: StartContext; message: RegExp }[] = [
    { check: "unassigned", key: "PAY-318", severity: "warn", actions: ["start", "cancel"], message: /assigned to nobody/ },
    { check: "assigned-other", key: "PAY-329", severity: "warn", actions: ["start", "cancel"], message: /assigned to Jane Doe/ },
    { check: "in-progress-other", key: "PAY-325", severity: "warn", actions: ["start", "cancel"], message: /Jane Doe already has PAY-325 in progress/ },
    { check: "closed", key: "PAY-328", severity: "warn", actions: ["reopen", "cancel"], message: /already done/ },
    { check: "not-in-sprint", key: "PAY-326", severity: "info", actions: ["start", "cancel"], message: /PAY Sprint 43, which is not the active sprint/ },
    { check: "blocked", key: "PAY-318", severity: "warn", actions: ["start", "open-blocker", "cancel"], target: "PAY-321", message: /blocked by PAY-321/ },
    { check: "flagged", key: "PAY-325", severity: "warn", actions: ["start", "cancel"], message: /flagged/ },
    { check: "no-permission", key: "PAY-327", severity: "info", actions: ["start-local", "cancel"], message: /may not move PAY-327/ },
    { check: "parent-closed", key: "PAY-323", severity: "info", actions: ["start", "cancel"], target: "PAY-322", message: /parent PAY-322 is already done/ },
    { check: "claimed-elsewhere", key: "PAY-324", severity: "warn", actions: ["start", "cancel"], message: /machine:7f3a is already working PAY-324 on PAY-324-idempotency-keys/ },
    { check: "agent-active", key: "PAY-322", severity: "block", actions: ["focus-tile", "cancel"], target: "tile-a", ctx: { actor: "test", activeTiles: [{ tile: "tile-a", issue: "PAY-322" }] }, message: /tile tile-a/ },
  ];

  for (const r of rows) {
    test(`#${rows.indexOf(r) + 1} ${r.check}: ${r.key}`, async () => {
      const { findings } = await checkStartWork(root, r.key, r.ctx ?? ctx);
      const f = findings.find((x) => x.check === r.check);
      expect(f).toMatchObject({ severity: r.severity, actions: r.actions, ...(r.target ? { target: r.target } : {}) });
      expect(f!.message).toMatch(r.message);
    });
  }

  test("an issue that is mine, in the active sprint, open and unblocked starts with nothing to say", async () => {
    expect((await checkStartWork(root, "PAY-330", ctx)).findings).toEqual([]);
  });

  test("a resolved blocker doesn't block; an unknown one (not mirrored here) still warns", async () => {
    const r2 = await mkRoot();
    await ingestRecords(r2, "jira:acme/PAY2", [{ ...recordOf("PAY-318"), external: { ...(recordOf("PAY-318").external as object), assignee: { name: "Me", me: true } } }]);
    const unknown = (await checkStartWork(r2, "PAY-318", ctx)).findings.find((f) => f.check === "blocked");
    expect(unknown?.message).toMatch(/isn't kept here/);
    await ingestRecords(r2, "jira:acme/PAY2", [recordOf("PAY-321", { status: "10006" })]);
    expect(checksOf((await checkStartWork(r2, "PAY-318", ctx)).findings)).not.toContain("blocked");
  });
});

test("#4 offers Reopen only when the issue's workflow has a way out of its closed status", async () => {
  const root = await mkRoot();
  const cats = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"];
  const statuses = cats.map((c) => ({ id: `jira:${c}`, name: c, category: c }));
  const workflow = (transitions: unknown[]) => ({ version: 1, statuses, issueTypes: { "jira:10001": { statuses: statuses.map((s) => s.id), transitions } } });
  await fs.writeFile(path.join(root, "workflow.yaml"), JSON.stringify(workflow([{ id: "1", from: ["jira:todo"], to: "jira:done" }])));
  await ingestRecords(root, SOURCE, [{ ...recordOf("PAY-328"), status: { id: "jira:done", name: "done", category: "done" }, external: { ...(recordOf("PAY-328").external as object), type: { id: "10001", name: "Story" } } }]);
  expect((await checkStartWork(root, "PAY-328", ctx)).findings.find((f) => f.check === "closed")?.actions).toEqual(["cancel"]);
  await fs.writeFile(path.join(root, "workflow.yaml"), JSON.stringify(workflow([{ id: "2", from: "*", to: "jira:todo" }])) + "\n");
  expect((await checkStartWork(root, "PAY-328", ctx)).findings.find((f) => f.check === "closed")?.actions).toEqual(["reopen", "cancel"]);
});

describe("checkStartWork on a local issue", () => {
  test("gets only #4, #6, #9 and #11", async () => {
    const root = await mkRoot();
    await createIssue(root, { title: "Parent", state: "done" }); // HIVE-1
    await createIssue(root, { title: "Blocker" }); // HIVE-2
    await createIssue(root, { title: "Work", parent: "HIVE-1", state: "cancelled" }); // HIVE-1.1
    const work = await readIssue(root, "HIVE-1.1");
    await writeIssue({ ...work, links: [{ id: "HIVE-2", type: "blocked-by" }] });
    const { findings } = await checkStartWork(root, "HIVE-1.1", { actor: "test", activeTiles: [{ tile: "t", issue: "HIVE-1.1" }] });
    expect(checksOf(findings)).toEqual(["closed", "blocked", "parent-closed", "agent-active"]);
  });

  test("a plain todo issue, as every workspace had before the guard, has no findings", async () => {
    const root = await mkRoot();
    await createIssue(root, { title: "Plain" });
    expect((await checkStartWork(root, "HIVE-1", ctx)).findings).toEqual([]);
  });
});

describe("a tracker's provider", () => {
  test("re-fetches a stale issue before checking it, and not a fresh one", async () => {
    const root = await mkRoot();
    await ingestRecords(root, SOURCE, [recordOf("PAY-318")]);
    const refreshed: string[] = [];
    const off = registerStartWorkProvider({
      source: "jira:",
      async refresh(r, issue): Promise<Issue> {
        refreshed.push(issue.id);
        // The tracker says it is mine now: written through ingest, as a real provider does.
        await ingestRecords(r, SOURCE, [{ ...recordOf("PAY-318"), external: { ...(recordOf("PAY-318").external as object), assignee: { name: "Ujjwal Solanki", me: true }, remoteUpdated: "2026-10-23T00:00:00.000Z" } }]);
        return readIssue(r, issue.id);
      },
    });
    try {
      const later = new Date(Date.now() + 120_000);
      const stale = await checkStartWork(root, "PAY-318", { actor: "test", now: later });
      expect(refreshed).toEqual(["PAY-318"]);
      expect(checksOf(stale.findings)).not.toContain("unassigned");
      await checkStartWork(root, "PAY-318", ctx); // just synced by the refresh
      expect(refreshed).toEqual(["PAY-318"]);
    } finally {
      off();
    }
  });

  test("offers Assign to me only when it can assign, and adds its own checks", async () => {
    const root = await mkRoot();
    await ingestRecords(root, SOURCE, [recordOf("PAY-318")]);
    const off = registerStartWorkProvider({
      source: "jira:",
      assignMe: async () => {},
      checks: async () => [{ check: "claimed-elsewhere", severity: "warn", message: "the tracker says machine:9 has it", actions: ["start", "cancel"] }],
    });
    try {
      const { findings } = await checkStartWork(root, "PAY-318", ctx);
      expect(findings.find((f) => f.check === "unassigned")?.actions).toEqual(["assign-me", "start", "cancel"]);
      expect(findings.find((f) => f.check === "claimed-elsewhere")?.message).toBe("the tracker says machine:9 has it");
    } finally {
      off();
    }
  });
});

test("--ack drops the checks it names, --force every warning, and nothing drops a block", () => {
  const f = (check: StartCheck, severity: StartFinding["severity"]): StartFinding => ({ check, severity, message: check, actions: [] });
  const all = [f("unassigned", "warn"), f("blocked", "warn"), f("not-in-sprint", "info"), f("agent-active", "block")];
  expect(checksOf(unacknowledged(all, { checks: ["unassigned"] }))).toEqual(["blocked", "agent-active"]);
  expect(checksOf(unacknowledged(all, { force: true }))).toEqual(["agent-active"]);
});
