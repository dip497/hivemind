import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createIssue, deleteIssueFile, listIssues, readIssue, updateIssue, writeConfig } from "./storage.js";
import { ignoreSyncFolders, sourceSlug } from "./mirror.js";

async function mkRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hive-mirror-"));
  const root = path.join(dir, ".hivemind");
  await fs.mkdir(path.join(root, "issues"), { recursive: true });
  await writeConfig(root, { prefix: "HIVE", next_id: 1, agents: {} });
  return root;
}

/** A mirrored issue file as a sync writes it, by hand (not through the serializer under test). */
async function mirrorFile(root: string, slug: string, id: string, extra: string[] = [], title = `Mirrored ${id}`): Promise<string> {
  const p = path.join(root, "mirror", slug, `${id}.md`);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const fm = [
    `id: ${id}`,
    `title: ${title}`,
    "state: todo",
    "parent: null",
    "labels: []",
    "assignee: null",
    "github: null",
    "external:",
    "  provider: jira",
    "  source: 'jira:acme/PAY'",
    `  id: '${id.length}${id.charCodeAt(0)}'`,
    `  key: ${id}`,
    ...extra,
    "created: '2026-10-13T08:00:00.000Z'",
    "updated: '2026-10-22T09:14:00.000Z'",
  ];
  await fs.writeFile(p, `---\n${fm.join("\n")}\n---\n## Description\n\nFrom Jira.\n`);
  return p;
}

describe("mirrored issues are issues", () => {
  test("listIssues returns local and mirrored issues together; readIssue finds a mirrored one by its key", async () => {
    const root = await mkRoot();
    await createIssue(root, { title: "local one" });
    const p = await mirrorFile(root, "jira-acme-PAY", "PAY-318");
    expect((await listIssues(root)).map((i) => i.id)).toEqual(["HIVE-1", "PAY-318"]);
    const issue = await readIssue(root, "PAY-318");
    expect(issue.path).toBe(p);
    expect(issue.external?.source).toBe("jira:acme/PAY");
  });

  test("a tracker key longer than a local prefix, or with an underscore, is a valid id", async () => {
    const root = await mkRoot();
    await mirrorFile(root, "jira-acme-LONG", "LONG_PROJECT_KEY-7");
    expect((await readIssue(root, "LONG_PROJECT_KEY-7")).title).toBe("Mirrored LONG_PROJECT_KEY-7");
    expect((await listIssues(root)).map((i) => i.id)).toEqual(["LONG_PROJECT_KEY-7"]);
  });

  test("an old key in `aliases` resolves to the issue that moved", async () => {
    const root = await mkRoot();
    await mirrorFile(root, "jira-acme-OPS", "OPS-7", ["aliases:", "  - PAY-112"]);
    const issue = await readIssue(root, "PAY-112");
    expect(issue.id).toBe("OPS-7");
    // a write through the alias lands on the one file, not a new one
    await updateIssue(root, "PAY-112", { labels: ["moved"] }, "test");
    expect((await readIssue(root, "OPS-7")).labels).toEqual(["moved"]);
    expect((await listIssues(root)).map((i) => i.id)).toEqual(["OPS-7"]);
  });

  test("ids that would leave .hivemind are refused before any file is touched", async () => {
    const root = await mkRoot();
    for (const bad of ["../../etc/passwd", "PAY-1/../../x", "A/../../../ETC/X-1", "PAY_X-1.2", "pay-1"]) {
      await expect(readIssue(root, bad)).rejects.toThrow(/invalid issue id/);
    }
  });

  test("deleting a mirrored issue removes its file", async () => {
    const root = await mkRoot();
    const p = await mirrorFile(root, "jira-acme-PAY", "PAY-318");
    await deleteIssueFile(root, "PAY-318");
    await expect(fs.stat(p)).rejects.toThrow();
    await expect(readIssue(root, "PAY-318")).rejects.toThrow(/not found/);
  });

  test("a sub-issue of a mirrored issue gets a local id of its own, not a dotted one", async () => {
    const root = await mkRoot();
    await mirrorFile(root, "jira-acme-PAY", "PAY-318");
    const child = await createIssue(root, { title: "split out", parent: "PAY-318" });
    expect(child.id).toBe("HIVE-1");
    expect(child.parent).toBe("PAY-318");
    // a local parent still nests
    expect((await createIssue(root, { title: "nested", parent: "HIVE-1" })).id).toBe("HIVE-1.1");
  });
});

describe("listIssues cache", () => {
  test("a file edited in place is read again, even at the same size", async () => {
    const root = await mkRoot();
    const p = await mirrorFile(root, "jira-acme-PAY", "PAY-318", [], "Title AAAA");
    expect((await listIssues(root))[0]!.title).toBe("Title AAAA");
    const raw = await fs.readFile(p, "utf8");
    await fs.writeFile(p, raw.replace("Title AAAA", "Title BBBB"));
    const later = new Date(Date.now() + 5_000);
    await fs.utimes(p, later, later); // same size: only the mtime says it changed
    expect((await listIssues(root))[0]!.title).toBe("Title BBBB");
  });

  test("a file that is gone drops out of the listing", async () => {
    const root = await mkRoot();
    const p = await mirrorFile(root, "jira-acme-PAY", "PAY-318");
    await mirrorFile(root, "jira-acme-PAY", "PAY-319");
    expect((await listIssues(root)).length).toBe(2);
    await fs.unlink(p);
    expect((await listIssues(root)).map((i) => i.id)).toEqual(["PAY-319"]);
  });
});

describe("sourceSlug", () => {
  test("a source id becomes a folder name every OS accepts", () => {
    expect(sourceSlug("jira:acme/PAY")).toBe("jira-acme-PAY");
    expect(sourceSlug("jira:https://acme.atlassian.net/PAY")).toBe("jira-https-acme.atlassian.net-PAY");
    expect(() => sourceSlug("../..")).toThrow();
    expect(() => sourceSlug(":/")).toThrow();
  });
});

describe("ignoreSyncFolders", () => {
  test("adds mirror/ and sync/ once, after what the .gitignore already holds", async () => {
    const root = await mkRoot();
    const gi = path.join(path.dirname(root), ".gitignore");
    await fs.writeFile(gi, "node_modules"); // no trailing newline
    expect(await ignoreSyncFolders(root)).toEqual([".hivemind/mirror/", ".hivemind/sync/"]);
    expect(await ignoreSyncFolders(root)).toEqual([]);
    expect(await fs.readFile(gi, "utf8")).toBe("node_modules\n.hivemind/mirror/\n.hivemind/sync/\n");
  });

  test("mirror.commit keeps the mirror in git; a repo ignoring all of .hivemind gets nothing", async () => {
    const root = await mkRoot();
    const gi = path.join(path.dirname(root), ".gitignore");
    expect(await ignoreSyncFolders(root, { commitMirror: true })).toEqual([".hivemind/sync/"]);
    expect(await fs.readFile(gi, "utf8")).toBe(".hivemind/sync/\n");
    await fs.writeFile(gi, ".hivemind/\n");
    expect(await ignoreSyncFolders(root)).toEqual([]);
  });
});
