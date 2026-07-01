import { describe, expect, test, beforeEach } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  HiveError,
  allocateId,
  appendActivity,
  createIssue,
  updateIssue,
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

  // $HOME handling: home is a valid workspace when it IS the starting dir, but a
  // subfolder must never climb up and resolve to ~/.hivemind (the "only home
  // gets selected" hijack). `home` is injected explicitly (2nd arg) so the
  // boundary is deterministic regardless of the runtime's os.homedir().
  describe("$HOME boundary", () => {
    let fakeHome: string;
    beforeEach(async () => {
      fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "fakehome-"));
    });

    async function mkHomeRoot(): Promise<string> {
      const root = path.join(fakeHome, ".hivemind");
      await fs.mkdir(path.join(root, "issues"), { recursive: true });
      await writeConfig(root, { prefix: "HOME", next_id: 1, agents: {} });
      return root;
    }

    test("resolves .hivemind AT $HOME when $HOME is the starting dir", async () => {
      const root = await mkHomeRoot();
      expect(await findRoot(fakeHome, fakeHome)).toBe(root);
    });

    test("a subfolder does NOT climb up into ~/.hivemind", async () => {
      await mkHomeRoot();
      const sub = path.join(fakeHome, "some-project", "src");
      await fs.mkdir(sub, { recursive: true });
      expect(await findRoot(sub, fakeHome)).toBe(null);
    });

    test("a subfolder still resolves its OWN .hivemind under $HOME", async () => {
      const proj = path.join(fakeHome, "some-project");
      const root = path.join(proj, ".hivemind");
      await fs.mkdir(path.join(root, "issues"), { recursive: true });
      await writeConfig(root, { prefix: "PROJ", next_id: 1, agents: {} });
      const deep = path.join(proj, "src", "lib");
      await fs.mkdir(deep, { recursive: true });
      expect(await findRoot(deep, fakeHome)).toBe(root);
    });

    test("$HOME's parent (e.g. /home) never resolves a workspace", async () => {
      // aboveHome guard: even a .hivemind sitting at $HOME's parent is ignored.
      const above = path.dirname(fakeHome);
      expect(await findRoot(above, fakeHome)).toBe(null);
    });
  });
});

describe("readConfig self-heal", () => {
  test("missing prefix → derived from repo dir, file rewritten", async () => {
    const root = await mkRoot();
    // Sabotage: drop the prefix field, simulating an early-init / hand-edited config.
    await fs.writeFile(path.join(root, "config.yaml"), "next_id: 5\nagents: {}\n", "utf8");
    const cfg = await readConfig(root);
    expect(cfg.next_id).toBe(5);
    expect(cfg.prefix).toMatch(/^[A-Z][A-Z0-9]{1,9}$/);
    // File must be rewritten so the next read is a no-op repair.
    const after = await fs.readFile(path.join(root, "config.yaml"), "utf8");
    expect(after).toMatch(/^prefix:/m);
    expect(after).toMatch(/next_id:\s*5/);
  });
  test("missing file entirely → defaults written", async () => {
    const root = await mkRoot();
    await fs.unlink(path.join(root, "config.yaml"));
    const cfg = await readConfig(root);
    expect(cfg.prefix).toMatch(/^[A-Z][A-Z0-9]{1,9}$/);
    expect(cfg.next_id).toBe(1);
  });
  test("concurrent self-heal callers share one write (race coalesced)", async () => {
    const root = await mkRoot();
    await fs.writeFile(path.join(root, "config.yaml"), "next_id: 7\nagents: {}\n", "utf8");
    // Race 20 readConfig() calls in parallel — they must all resolve to the
    // same repaired value and the file must be valid YAML afterward (no
    // half-truncated content from interleaved writes).
    const results = await Promise.all(Array.from({ length: 20 }, () => readConfig(root)));
    const first = results[0]!;
    for (const r of results) {
      expect(r.prefix).toBe(first.prefix);
      expect(r.next_id).toBe(first.next_id);
    }
    const after = await fs.readFile(path.join(root, "config.yaml"), "utf8");
    expect(after).toMatch(/^prefix:/m);
    expect(after).toMatch(/next_id:\s*7/);
  });
  test("garbage prefix → falls back to derived", async () => {
    const root = await mkRoot();
    await fs.writeFile(path.join(root, "config.yaml"), "prefix: 123\nnext_id: 1\nagents: {}\n", "utf8");
    const cfg = await readConfig(root);
    expect(cfg.prefix).toMatch(/^[A-Z][A-Z0-9]{1,9}$/);
    expect(cfg.prefix).not.toBe("123");
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

  test("concurrent allocations get UNIQUE ids (no collision)", async () => {
    const root = await mkRoot();
    // Fire many in parallel — without the per-root serialization these would
    // read the same next_id and mint duplicate ids, then clobber each other.
    const N = 20;
    const ids = (await Promise.all(Array.from({ length: N }, () => allocateId(root)))).map((r) => r.id);
    expect(new Set(ids).size).toBe(N); // all unique
    expect((await readConfig(root)).next_id).toBe(N + 1);
    const nums = ids.map((id) => Number(id.split("-")[1])).sort((a, b) => a - b);
    expect(nums).toEqual(Array.from({ length: N }, (_, i) => i + 1)); // exactly 1..N
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
  test("plain `Acceptance criteria:` label inside description is split out", () => {
    // Agents (hive_create_issue) embed the checklist under a plain label line
    // inside the free-text description — not a `## ` heading. It must still
    // reach the acceptanceCriteria section, and the real description must NOT
    // include the checklist lines.
    const s = parseSections(
      "## Description\n\nReal desc text.\n\nAcceptance criteria:\n- [ ] first\n- [x] second\n\n## Activity\n\n- 2026-05-17 10:00 · ui · created",
    );
    expect(s.description).toBe("Real desc text.");
    expect(s.acceptanceCriteria).toEqual([
      { done: false, text: "first" },
      { done: true, text: "second" },
    ]);
    expect(s.activity.length).toBe(1);
  });
  test("bold `**Acceptance criteria:**` label is split out", () => {
    const s = parseSections(
      "## Description\n\nD.\n\n**Acceptance criteria:**\n- [ ] x",
    );
    expect(s.description).toBe("D.");
    expect(s.acceptanceCriteria).toEqual([{ done: false, text: "x" }]);
  });
  test("activity entries parsed", () => {
    const s = parseSections(
      "## Activity\n\n- 2026-05-17 10:00 · sarah · created\n- 2026-05-17 11:00 · claude · changed state"
    );
    expect(s.activity).toEqual([
      { at: "2026-05-17T10:00:00.000Z", rawAt: "2026-05-17 10:00", who: "sarah", message: "created" },
      { at: "2026-05-17T11:00:00.000Z", rawAt: "2026-05-17 11:00", who: "claude", message: "changed state" },
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
  test("stores full ISO with Z so renderers parse it as UTC", async () => {
    const root = await mkRoot();
    const issue: Issue = {
      id: "PAY-1",
      title: "T",
      state: "todo",
      parent: null,
      labels: [],
      assignee: null,
      github: null,
      created: "2026-05-17T10:00:00Z",
      updated: "2026-05-17T10:00:00Z",
      path: issuePath(root, "PAY-1"),
      sections: { description: "", acceptanceCriteria: [], activity: [], extra: "" },
      raw: "",
    };
    const fixed = new Date("2026-05-17T10:00:00Z");
    appendActivity(issue, "ui", "created", fixed);
    const at = issue.sections.activity[0]!.at;
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(new Date(at).getTime()).toBe(fixed.getTime());
    // Round-trips through markdown without timezone drift.
    await writeIssue(issue);
    const back = await readIssue(root, "PAY-1");
    expect(back.sections.activity[0]?.at).toBe(at);
    expect(new Date(back.sections.activity[0]!.at).getTime()).toBe(fixed.getTime());
  });
  test("legacy `YYYY-MM-DD HH:MM` activity rows round-trip without churn", async () => {
    const root = await mkRoot();
    const md = `---
id: PAY-1
title: T
state: todo
parent: null
labels: []
assignee: null
github: null
created: "2026-05-17T10:00:00Z"
updated: "2026-05-17T10:00:00Z"
---

## Activity

- 2026-05-17 10:00 · ui · created
`;
    await fs.writeFile(issuePath(root, "PAY-1"), md, "utf8");
    const issue = await readIssue(root, "PAY-1");
    // After writeIssue the legacy timestamp tokens must NOT have been
    // rewritten to ISO — that would produce noisy diffs on every first
    // updateIssue after upgrade.
    await writeIssue(issue);
    const after = await fs.readFile(issuePath(root, "PAY-1"), "utf8");
    expect(after).toMatch(/- 2026-05-17 10:00 · ui · created/);
    expect(after).not.toMatch(/2026-05-17T10:00:00\.000Z · ui · created/);
  });
  test("legacy `YYYY-MM-DD HH:MM` activity timestamps are normalized to ISO-Z for `at`", async () => {
    const root = await mkRoot();
    const md = `---
id: PAY-1
title: T
state: todo
parent: null
labels: []
assignee: null
github: null
created: "2026-05-17T10:00:00Z"
updated: "2026-05-17T10:00:00Z"
---

## Activity

- 2026-05-17 10:00 · ui · created
`;
    await fs.writeFile(issuePath(root, "PAY-1"), md, "utf8");
    const issue = await readIssue(root, "PAY-1");
    expect(issue.sections.activity[0]?.at).toBe("2026-05-17T10:00:00.000Z");
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
    expect(back.sections.description).toBe("D body.");
  });
});

describe("createIssue / updateIssue (CLI + UI write path)", () => {
  test("createIssue records the given actor + an ISO timestamp", async () => {
    const root = await mkRoot();
    const issue = await createIssue(root, { title: "hello", who: "cli:alice" });
    expect(issue.id).toBe("PAY-1");
    const act = issue.sections.activity[0]!;
    expect(act.who).toBe("cli:alice");
    expect(act.message).toBe("created");
    // ISO-Z, not the legacy "YYYY-MM-DD HH:MM" form.
    expect(act.at).toMatch(/T.*Z$/);
  });

  test("createIssue defaults actor to 'ui' and carries github", async () => {
    const root = await mkRoot();
    const issue = await createIssue(root, { title: "x", github: 42 });
    expect(issue.sections.activity[0]!.who).toBe("ui");
    expect(issue.github).toBe(42);
  });

  test("updateIssue appends a note in the SAME write as the patch", async () => {
    const root = await mkRoot();
    const created = await createIssue(root, { title: "t" });
    const updated = await updateIssue(root, created.id, { state: "in_progress" }, "cli:bob", "starting now");
    const msgs = updated.sections.activity.map((a) => a.message);
    expect(msgs).toContain("state: todo → in_progress");
    expect(msgs).toContain("starting now");
    // Re-read from disk: one write, both entries persisted.
    const reread = await readIssue(root, created.id);
    expect(reread.sections.activity.map((a) => a.message)).toContain("starting now");
  });

  test("updateIssue can unset github via null", async () => {
    const root = await mkRoot();
    const created = await createIssue(root, { title: "t", github: 7 });
    const updated = await updateIssue(root, created.id, { github: null }, "ui");
    expect(updated.github).toBe(null);
    expect(updated.sections.activity.map((a) => a.message)).toContain("github: 7 → —");
  });
});
