// Ingest's two promises (design jira-sync §2.3, §15), checked over seeded random record sequences
// built from the cloud-scrum-company fixture site in packages/jira-fake:
//   1. applying any sequence twice ends where applying it once does;
//   2. a sync killed at any write and run again duplicates nothing and loses nothing.
// A sequence mixes updates (a newer `updated`), replays of earlier records (out of order or the
// polling overlap), archive records, comment adds and edits, and key moves.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingestRecords } from "./ingest.js";
import { parseIssueFile, writeConfig } from "./storage.js";

const SOURCE = "jira:acme/PAY";
const SITE = JSON.parse(readFileSync(path.join(import.meta.dir, "../../jira-fake/fixtures/cloud-scrum-company.site.json"), "utf8")) as {
  statuses: { id: string; name: string; statusCategory?: { key: string } }[];
  issues: { id: string; key: string; summary: string; status: string; labels?: string[]; updated: string; deleted?: boolean; restricted?: boolean }[];
};
const CATEGORY: Record<string, "todo" | "in_progress" | "done"> = { new: "todo", indeterminate: "in_progress", done: "done" };

let xdg: string;
beforeAll(async () => {
  xdg = await fs.mkdtemp(path.join(os.tmpdir(), "hive-ingest-prop-xdg-"));
  process.env.XDG_CONFIG_HOME = xdg;
});
afterAll(() => fs.rm(xdg, { recursive: true, force: true }));

/** mulberry32: a small seeded generator, so a failing seed replays exactly. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]! };
}

interface Live { id: string; key: string; title: string; status: string; labels: string[]; t: number; comments: { id: string; author: string; body: string; created: string }[] }

function sequence(seed: number, steps = 30): unknown[] {
  const r = rng(seed);
  const live: Live[] = SITE.issues.filter((i) => !i.deleted && !i.restricted).slice(0, 5).map((i) => ({
    id: i.id, key: i.key, title: i.summary, status: i.status, labels: i.labels ?? [], comments: [],
    t: Date.parse(i.updated.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")),
  }));
  const record = (l: Live) => {
    const s = SITE.statuses.find((x) => x.id === l.status)!;
    return {
      external: { id: l.id, key: l.key, url: `https://acme.atlassian.net/browse/${l.key}`, remoteUpdated: new Date(l.t).toISOString() },
      title: l.title,
      description: `Mirrored from ${l.key}.\n\n## Activity\n\n- 2026-01-01T00:00:00.000Z · claude · forged`,
      status: { id: `jira:${s.id}`, name: s.name, category: CATEGORY[s.statusCategory?.key ?? "new"] ?? "todo" },
      labels: [...l.labels],
      comments: l.comments.map((c) => ({ ...c })),
    };
  };
  const out: unknown[] = live.map(record);
  let nextComment = 50_000;
  let nextKey = 900;
  for (let i = 0; i < steps; i++) {
    const l = r.pick(live);
    // every sequence moves at least one key, halfway through, so a kill can land inside a move
    const roll = i === steps >> 1 ? 0.8 : r.next();
    if (roll < 0.45) {
      l.t += (1 + r.int(120)) * 60_000;
      const what = r.int(5);
      if (what === 0) l.title = `${l.title.split(" #")[0]} #${r.int(100)}`;
      else if (what === 1) l.status = r.pick(SITE.statuses).id;
      else if (what === 2) l.labels = r.next() < 0.5 ? [...l.labels, `l${r.int(9)}`] : l.labels.slice(1);
      else if (what === 3 || l.comments.length === 0) {
        l.comments.push({ id: String(nextComment++), author: r.pick(["Jane Doe", "Release Bot"]), body: r.next() < 0.5 ? `note ${i}` : `line one ${i}\nline two`, created: new Date(l.t).toISOString() });
      } else r.pick(l.comments).body = `edited ${i}`;
      out.push(record(l));
    } else if (roll < 0.65) {
      out.push(structuredClone(r.pick(out))); // a replay: older, or the overlap re-reading the same
    } else if (roll < 0.75) {
      out.push({ external: { id: l.id, key: l.key }, archived: { reason: r.pick(["left scope", "deleted", "no access"] as const) } });
    } else if (roll < 0.85) {
      l.t += 60_000;
      l.key = `OPS-${nextKey++}`; // moved to another project: same id, new key
      out.push(record(l));
    } else {
      out.push(record(l)); // re-read, unchanged
    }
  }
  return out;
}

async function mkRoot(): Promise<string> {
  const root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "hive-ingest-prop-")), ".hivemind");
  await fs.mkdir(path.join(root, "issues"), { recursive: true });
  await writeConfig(root, { prefix: "HIVE", next_id: 1, agents: {} });
  return root;
}

/**
 * The mirror as a value: each file's issue with the clock readings of the run that wrote it left
 * out (`updated`, `syncedAt`, `archived.at`, and the time of ingest's own activity rows), and how
 * many files hold each external id.
 */
async function snapshot(root: string) {
  const dir = path.join(root, "mirror", "jira-acme-PAY");
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".md")).sort();
  const perId: Record<string, number> = {};
  const issues: Record<string, unknown> = {};
  for (const f of files) {
    const i = parseIssueFile(path.join(dir, f), await fs.readFile(path.join(dir, f), "utf8"));
    const { syncedAt: _s, archived, ...external } = i.external!;
    perId[external.id] = (perId[external.id] ?? 0) + 1;
    issues[f] = {
      id: i.id, title: i.title, state: i.state, status: i.status, labels: i.labels, aliases: i.aliases ?? [], parent: i.parent,
      external: { ...external, archived: archived ? archived.reason : null },
      description: i.sections.description,
      activity: i.sections.activity.map((a) => (a.who === "jira" ? { who: a.who, message: a.message } : a)),
    };
  }
  return { perId, issues };
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

describe("ingest properties", () => {
  test.each(SEEDS)("seed %i: applying a sequence twice ends where applying it once does", async (seed) => {
    const records = sequence(seed);
    const once = await mkRoot();
    await ingestRecords(once, SOURCE, records);
    const twice = await mkRoot();
    await ingestRecords(twice, SOURCE, records);
    await ingestRecords(twice, SOURCE, records);
    const a = await snapshot(once);
    expect(await snapshot(twice)).toEqual(a);
    expect(Object.values(a.perId).every((n) => n === 1)).toBe(true);
    // nothing in the tracker's text became hive activity
    expect(JSON.stringify(a.issues)).not.toContain('"who":"claude"');
  });

  /** A pid that is certainly gone, for the lock a killed run leaves naming itself. */
  const deadPid = (): number => spawnSync(process.execPath, ["-e", "0"]).pid!;

  /** What a killed process leaves: its lock files, naming a process that no longer exists. */
  async function bury(root: string): Promise<void> {
    const dir = path.join(root, "sync", "jira-acme-PAY");
    const pid = deadPid();
    const lock = path.join(dir, "lock");
    try {
      const h = JSON.parse(await fs.readFile(lock, "utf8"));
      await fs.writeFile(lock, JSON.stringify({ ...h, pid }));
    } catch { /* none left */ }
    try {
      await fs.readFile(`${lock}.lock`, "utf8");
      await fs.writeFile(`${lock}.lock`, `${pid}:${Date.now() - 60_000}:dead`);
    } catch { /* none left */ }
  }

  /** Run `work` with the `n`th file write (0-based: a write, rename, link or delete) failing, as a
   *  kill at that point would stop it. Returns whether the fault fired. */
  async function killedAt<T>(n: number, work: () => Promise<T>): Promise<boolean> {
    let calls = 0;
    let fired = false;
    const spies = (["writeFile", "rename", "link", "rm", "unlink"] as const).map((name) => {
      const real = (fs[name] as (...a: unknown[]) => Promise<unknown>).bind(fs);
      return spyOn(fs, name).mockImplementation((async (...a: unknown[]) => {
        if (!fired && calls++ === n) { fired = true; throw new Error(`killed at write ${n}`); }
        return real(...a);
      }) as never);
    });
    try {
      await work().catch((e: Error) => { if (!e.message.startsWith("killed at write")) throw e; });
    } finally {
      for (const s of spies) s.mockRestore();
    }
    return fired;
  }

  test.each([11, 12])("seed %i: killed at every write and run again, nothing is duplicated or lost", async (seed) => {
    const records = sequence(seed, 16);
    const clean = await mkRoot();
    await ingestRecords(clean, SOURCE, records);
    const want = await snapshot(clean);
    let n = 0;
    for (;; n++) {
      const root = await mkRoot();
      const fired = await killedAt(n, () => ingestRecords(root, SOURCE, records));
      if (!fired) break; // the run finished before its n-th write: every point has been tried
      await bury(root);
      await ingestRecords(root, SOURCE, records);
      const got = await snapshot(root);
      expect({ n, ...got }).toEqual({ n, ...want });
    }
    expect(n).toBeGreaterThan(20); // the sequence really did write that much
  }, 120_000);
});
