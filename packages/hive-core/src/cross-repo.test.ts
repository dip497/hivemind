import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeConfig } from "./storage.js";
import { createIssue, readIssue, listIssues } from "./storage.js";
import {
  listWorkspaces,
  prefixOf,
  registerWorkspace,
  registryPath,
  resolveWorkspaceByPrefix,
} from "./registry.js";
import {
  linkIssues,
  reciprocalLinkType,
  resolveIssueRef,
  transferIssue,
  unlinkIssues,
} from "./cross-repo.js";

let tmp: string;
let prevXdg: string | undefined;

/** Create an initialized workspace with a given prefix under tmp. Returns root. */
async function mkWorkspace(name: string, prefix: string): Promise<string> {
  const repo = path.join(tmp, name);
  const root = path.join(repo, ".hivemind");
  await fs.mkdir(path.join(root, "issues"), { recursive: true });
  await writeConfig(root, { prefix, next_id: 1, agents: {} });
  await registerWorkspace(root);
  return root;
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hm-xr-"));
  // Point the registry at an isolated dir so tests don't touch the real one.
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg");
});

afterEach(async () => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("registry", () => {
  test("registers + resolves a workspace by prefix", async () => {
    const root = await mkWorkspace("alpha", "ALPHA");
    expect(registryPath().startsWith(path.join(tmp, "xdg"))).toBe(true);
    const e = await resolveWorkspaceByPrefix("ALPHA");
    expect(e?.root).toBe(root);
    expect(e?.title).toBe("alpha");
  });

  test("unknown prefix resolves null", async () => {
    expect(await resolveWorkspaceByPrefix("NOPE")).toBeNull();
  });

  test("listWorkspaces prunes dead roots", async () => {
    await mkWorkspace("alpha", "ALPHA");
    const betaRoot = await mkWorkspace("beta", "BETA");
    await fs.rm(path.dirname(betaRoot), { recursive: true, force: true });
    const ws = await listWorkspaces();
    expect(ws.map((w) => w.prefix)).toEqual(["ALPHA"]);
  });

  test("prefixOf extracts prefix incl. sub-issues", () => {
    expect(prefixOf("MANAGEARK-3")).toBe("MANAGEARK");
    expect(prefixOf("PAY-1.2.3")).toBe("PAY");
    expect(prefixOf("nonsense")).toBeNull();
  });
});

describe("reciprocalLinkType", () => {
  test("maps pairs + symmetric", () => {
    expect(reciprocalLinkType("blocks")).toBe("blocked-by");
    expect(reciprocalLinkType("blocked-by")).toBe("blocks");
    expect(reciprocalLinkType("parent-of")).toBe("child-of");
    expect(reciprocalLinkType("moved-to")).toBe("moved-from");
    expect(reciprocalLinkType("relates")).toBe("relates");
    expect(reciprocalLinkType("duplicates")).toBe("duplicates");
  });
});

describe("linkIssues", () => {
  test("writes reciprocal links on both repos", async () => {
    const a = await mkWorkspace("alpha", "ALPHA");
    const b = await mkWorkspace("beta", "BETA");
    const ia = await createIssue(a, { title: "A one" });
    const ib = await createIssue(b, { title: "B one" });
    const res = await linkIssues(a, ia.id, ib.id, "blocks", "tester");
    expect(res.type).toBe("blocks");
    expect(res.reciprocal).toBe("blocked-by");
    const ra = await readIssue(a, ia.id);
    const rb = await readIssue(b, ib.id);
    expect(ra.links).toEqual([{ id: ib.id, type: "blocks" }]);
    expect(rb.links).toEqual([{ id: ia.id, type: "blocked-by" }]);
  });

  test("link to unknown workspace throws", async () => {
    const a = await mkWorkspace("alpha", "ALPHA");
    const ia = await createIssue(a, { title: "A one" });
    await expect(linkIssues(a, ia.id, "GHOST-9", "relates")).rejects.toThrow(/unknown_workspace|no registered/);
  });

  test("unlink removes both ends", async () => {
    const a = await mkWorkspace("alpha", "ALPHA");
    const b = await mkWorkspace("beta", "BETA");
    const ia = await createIssue(a, { title: "A" });
    const ib = await createIssue(b, { title: "B" });
    await linkIssues(a, ia.id, ib.id, "relates");
    const removed = await unlinkIssues(a, ia.id, ib.id);
    expect(removed).toBe(2);
    expect((await readIssue(a, ia.id)).links ?? []).toEqual([]);
    expect((await readIssue(b, ib.id)).links ?? []).toEqual([]);
  });
});

describe("transferIssue", () => {
  test("copy creates dest issue with new id + reciprocal relates, source stays", async () => {
    const a = await mkWorkspace("alpha", "ALPHA");
    const b = await mkWorkspace("beta", "BETA");
    const src = await createIssue(a, {
      title: "Port me",
      description: "desc",
      labels: ["x"],
      acceptanceCriteria: [{ done: false, text: "crit" }],
    });
    const res = await transferIssue(a, src.id, "BETA", { mode: "copy", actor: "tester" });
    expect(res.mode).toBe("copy");
    expect(prefixOf(res.newId)).toBe("BETA");
    const dest = await readIssue(b, res.newId);
    expect(dest.title).toBe("Port me");
    expect(dest.sections.acceptanceCriteria).toEqual([{ done: false, text: "crit" }]);
    expect(dest.links).toEqual([{ id: src.id, type: "relates" }]);
    // source still exists with a reciprocal link
    const stillThere = await readIssue(a, src.id);
    expect(stillThere.links).toEqual([{ id: res.newId, type: "relates" }]);
  });

  test("move creates dest with moved-from + deletes source", async () => {
    const a = await mkWorkspace("alpha", "ALPHA");
    const b = await mkWorkspace("beta", "BETA");
    const src = await createIssue(a, { title: "Move me" });
    const res = await transferIssue(a, src.id, "BETA", { mode: "move" });
    expect(res.mode).toBe("move");
    const dest = await readIssue(b, res.newId);
    expect(dest.links).toEqual([{ id: src.id, type: "moved-from" }]);
    await expect(readIssue(a, src.id)).rejects.toThrow(/not found/);
    expect(await listIssues(a)).toEqual([]);
  });

  test("move refuses an issue with sub-issues", async () => {
    const a = await mkWorkspace("alpha", "ALPHA");
    await mkWorkspace("beta", "BETA");
    const parent = await createIssue(a, { title: "Parent" });
    await createIssue(a, { title: "Child", parent: parent.id });
    await expect(transferIssue(a, parent.id, "BETA", { mode: "move" })).rejects.toThrow(/sub-issues/);
  });

  test("transfer to unknown prefix throws", async () => {
    const a = await mkWorkspace("alpha", "ALPHA");
    const src = await createIssue(a, { title: "x" });
    await expect(transferIssue(a, src.id, "GHOST", { mode: "copy" })).rejects.toThrow(/no registered/);
  });

  test("resolveIssueRef resolves cross-repo by id", async () => {
    await mkWorkspace("alpha", "ALPHA");
    const b = await mkWorkspace("beta", "BETA");
    const ib = await createIssue(b, { title: "findme" });
    const { root, issue } = await resolveIssueRef(ib.id);
    expect(root).toBe(b);
    expect(issue.title).toBe("findme");
  });
});
