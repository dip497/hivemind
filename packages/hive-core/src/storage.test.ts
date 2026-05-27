import { describe, expect, test, beforeEach } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  HiveError,
  allocateId,
  appendActivity,
  deleteIssueFile,
  findRoot,
  issuePath,
  listIssues,
  parseSections,
  readConfig,
  readIssue,
  serializeIssue,
  writeConfig,
  writeIssue,
} from "./storage.js";
import type { Issue } from "./types.js";

async function mkRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hive-test-"));
  const root = path.join(dir, ".hivemind");
  await fs.mkdir(path.join(root, "issues"), { recursive: true });
  await fs.mkdir(path.join(root, "cycles"), { recursive: true });
  await writeConfig(root, { prefix: "PAY", next_id: 1, agents: {} });
  return root;
}

describe("issuePath", () => {
  test("top-level id", () => {
    expect(issuePath("/root/.hivemind", "PAY-118")).toBe(
      "/root/.hivemind/issues/PAY-118.md"
    );
  });
  test("sub-issue id", () => {
    expect(issuePath("/root/.hivemind", "PAY-122.1")).toBe(
      "/root/.hivemind/issues/PAY-122/PAY-122.1.md"
    );
  });
  test("deeply nested", () => {
    expect(issuePath("/root/.hivemind", "PAY-1.2.3")).toBe(
      "/root/.hivemind/issues/PAY-1/PAY-1.2/PAY-1.2.3.md"
    );
  });
});

describe("findRoot", () => {
  test("returns null when no .hivemind/ anywhere", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noroot-"));
    expect(await findRoot(dir)).toBe(null);
  });
  test("finds .hivemind/ in cwd", async () => {
    const root = await mkRoot();
    expect(await findRoot(path.dirname(root))).toBe(root);
  });
  test("walks up from a deep child", async () => {
    const root = await mkRoot();
    const deep = path.join(path.dirname(root), "src", "lib", "deep");
    await fs.mkdir(deep, { recursive: true });
    expect(await findRoot(deep)).toBe(root);
  });
});

describe("allocateId", () => {
  test("increments next_id", async () => {
    const root = await mkRoot();
    const a = await allocateId(root);
    const b = await allocateId(root);
    expect(a.id).toBe("PAY-1");
    expect(b.id).toBe("PAY-2");
    expect((await readConfig(root)).next_id).toBe(3);
  });
});

describe("write+read round-trip", () => {
  test("simple issue", async () => {
    const root = await mkRoot();
    const now = new Date().toISOString();
    const issue: Issue = {
      id: "PAY-1",
      title: "First bug",
      state: "todo",
      parent: null,
      labels: ["bug"],
      assignee: { type: "agent", id: "claude", model: "opus-4.7" },
      github: null,
      cycle: null,
      created: now,
      updated: now,
      path: issuePath(root, "PAY-1"),
      sections: {
        description: "First description.",
        acceptanceCriteria: [
          { done: false, text: "Do A" },
          { done: true, text: "Do B" },
        ],
        activity: [{ at: "2026-05-17 10:00", who: "sarah", message: "created" }],
        extra: "",
      },
      raw: "",
    };
    await writeIssue(issue);
    const back = await readIssue(root, "PAY-1");
    expect(back.title).toBe("First bug");
    expect(back.state).toBe("todo");
    expect(back.labels).toEqual(["bug"]);
    expect(back.assignee?.id).toBe("claude");
    expect(back.sections.acceptanceCriteria).toEqual([
      { done: false, text: "Do A" },
      { done: true, text: "Do B" },
    ]);
    expect(back.sections.activity[0]?.who).toBe("sarah");
  });

  test("sub-issue lives in parent dir", async () => {
    const root = await mkRoot();
    const now = new Date().toISOString();
    const sub: Issue = {
      id: "PAY-122.1",
      title: "Subtask",
      state: "todo",
      parent: "PAY-122",
      labels: [],
      assignee: null,
      github: null,
      cycle: null,
      created: now,
      updated: now,
      path: issuePath(root, "PAY-122.1"),
      sections: { description: "", acceptanceCriteria: [], activity: [], extra: "" },
      raw: "",
    };
    await writeIssue(sub);
    const p = path.join(root, "issues", "PAY-122", "PAY-122.1.md");
    expect((await fs.stat(p)).isFile()).toBe(true);
  });

  test("missing issue throws HiveError(not_found)", async () => {
    const root = await mkRoot();
    try {
      await readIssue(root, "PAY-999");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(HiveError);
      expect((e as HiveError).code).toBe("not_found");
    }
  });
});

describe("listIssues", () => {
  test("returns all, sorted by id", async () => {
    const root = await mkRoot();
    const now = new Date().toISOString();
    for (const id of ["PAY-3", "PAY-1", "PAY-2"]) {
      const issue: Issue = {
        id,
        title: `T-${id}`,
        state: "todo",
        parent: null,
        labels: [],
        assignee: null,
        github: null,
        cycle: null,
        created: now,
        updated: now,
        path: issuePath(root, id),
        sections: { description: "", acceptanceCriteria: [], activity: [], extra: "" },
        raw: "",
      };
      await writeIssue(issue);
    }
    const list = await listIssues(root);
    expect(list.map((i) => i.id)).toEqual(["PAY-1", "PAY-2", "PAY-3"]);
  });
  test("sub-issues sort under parents", async () => {
    const root = await mkRoot();
    const now = new Date().toISOString();
    const ids = ["PAY-2", "PAY-1.10", "PAY-1.2", "PAY-1", "PAY-10"];
    for (const id of ids) {
      const issue: Issue = {
        id,
        title: id,
        state: "todo",
        parent: id.includes(".") ? id.replace(/\.\d+$/, "") : null,
        labels: [],
        assignee: null,
        github: null,
        cycle: null,
        created: now,
        updated: now,
        path: issuePath(root, id),
        sections: { description: "", acceptanceCriteria: [], activity: [], extra: "" },
        raw: "",
      };
      await writeIssue(issue);
    }
    const list = (await listIssues(root)).map((i) => i.id);
    expect(list).toEqual(["PAY-1", "PAY-1.2", "PAY-1.10", "PAY-2", "PAY-10"]);
  });
});

describe("parseSections", () => {
  test("missing headings → all body becomes description", () => {
    const s = parseSections("Hello world\n\nMore text.");
    expect(s.description).toBe("Hello world\n\nMore text.");
    expect(s.acceptanceCriteria).toEqual([]);
    expect(s.activity).toEqual([]);
  });
  test("acceptance criteria parses checkboxes", () => {
    const s = parseSections(
      "## Description\n\nDesc.\n\n## Acceptance criteria\n\n- [x] done item\n- [ ] todo item"
    );
    expect(s.acceptanceCriteria).toEqual([
      { done: true, text: "done item" },
      { done: false, text: "todo item" },
    ]);
  });
  test("activity entries parsed", () => {
    const s = parseSections(
      "## Activity\n\n- 2026-05-17 10:00 · sarah · created\n- 2026-05-17 11:00 · claude · changed state"
    );
    expect(s.activity).toEqual([
      { at: "2026-05-17 10:00", who: "sarah", message: "created" },
      { at: "2026-05-17 11:00", who: "claude", message: "changed state" },
    ]);
  });
});

describe("appendActivity", () => {
  test("appends and bumps updated", async () => {
    const root = await mkRoot();
    const now = "2026-05-17T10:00:00Z";
    const issue: Issue = {
      id: "PAY-1",
      title: "T",
      state: "todo",
      parent: null,
      labels: [],
      assignee: null,
      github: null,
      cycle: null,
      created: now,
      updated: now,
      path: issuePath(root, "PAY-1"),
      sections: { description: "", acceptanceCriteria: [], activity: [], extra: "" },
      raw: "",
    };
    appendActivity(issue, "claude", "state todo → in_progress");
    expect(issue.sections.activity.length).toBe(1);
    expect(issue.updated).not.toBe(now);
  });
});

describe("delete cleans empty parent dirs", () => {
  test("removes empty PAY-122/ after deleting last child", async () => {
    const root = await mkRoot();
    const now = new Date().toISOString();
    const sub: Issue = {
      id: "PAY-122.1",
      title: "S",
      state: "todo",
      parent: "PAY-122",
      labels: [],
      assignee: null,
      github: null,
      cycle: null,
      created: now,
      updated: now,
      path: issuePath(root, "PAY-122.1"),
      sections: { description: "", acceptanceCriteria: [], activity: [], extra: "" },
      raw: "",
    };
    await writeIssue(sub);
    expect(
      (await fs.stat(path.join(root, "issues", "PAY-122"))).isDirectory()
    ).toBe(true);
    await deleteIssueFile(root, "PAY-122.1");
    try {
      await fs.stat(path.join(root, "issues", "PAY-122"));
      throw new Error("expected dir removed");
    } catch (e: unknown) {
      const err = e as { code?: string };
      expect(err.code).toBe("ENOENT");
    }
  });
});

describe("serializeIssue round-trip is stable", () => {
  test("serialize then parse yields equal fields", async () => {
    const root = await mkRoot();
    const now = "2026-05-17T10:00:00Z";
    const original: Issue = {
      id: "PAY-7",
      title: "Round-trip me",
      state: "in_progress",
      parent: null,
      labels: ["bug", "perf"],
      assignee: { type: "agent", id: "claude" },
      github: 487,
      cycle: "cycle-14",
      created: now,
      updated: now,
      path: issuePath(root, "PAY-7"),
      sections: {
        description: "D body.",
        acceptanceCriteria: [{ done: false, text: "A" }],
        activity: [{ at: "2026-05-17 10:00", who: "claude", message: "started" }],
        extra: "",
      },
      raw: "",
    };
    const text = serializeIssue(original);
    await fs.writeFile(original.path, text, "utf8");
    const back = await readIssue(root, "PAY-7");
    expect(back.id).toBe("PAY-7");
    expect(back.title).toBe("Round-trip me");
    expect(back.state).toBe("in_progress");
    expect(back.labels).toEqual(["bug", "perf"]);
    expect(back.assignee?.id).toBe("claude");
    expect(back.github).toBe(487);
    expect(back.cycle).toBe("cycle-14");
    expect(back.sections.description).toBe("D body.");
  });
});
