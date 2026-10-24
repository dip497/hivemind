// `hive ingest`: the one write path for every source that mirrors issues from an external tracker
// (design jira-sync §5.4). The Jira REST service, an MCP transport and an agent holding a Jira
// connector differ only in how they READ; each hands ingest the same normalised records, and
// correctness — idempotence, crash safety, key moves, archiving, the status conflict rule — lives
// here, once.
//
// Record text (titles, descriptions, comments) is data from someone else's tracker. It is written
// into issue files and shown, never followed: lines that would read as a section heading or an
// activity row are escaped, so a description can't forge hive's own sections or activity.
//
// What is on disk is the truth; the ledger (`sync/<slug>/ledger.json`) is bookkeeping on top. The
// sync identity is `external.source` + `external.id`, read from the mirrored files themselves, and
// every file write is atomic. So a sync killed at any write and run again finds what it already
// wrote, never writes a second file for one issue, and loses nothing.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  AcceptanceItemZ,
  ExternalArchivedZ,
  ExternalRefZ,
  ExternalUserZ,
  IssueStateZ,
  type ExternalRef,
  type Issue,
  type IssueState,
} from "./types.js";
import { EXTERNAL_PREFIX_RE, ISSUE_ID_RE, issuePrefix } from "./issue-id.js";
import { HiveError, appendActivity, parseIssueFile, readConfig, scanIssueFiles, serializeIssue, updateConfig, writeFileAtomic } from "./storage.js";
import { ignoreSyncFolders, mirrorDir, syncDir } from "./mirror.js";
import { registerWorkspace } from "./registry.js";
import { withSyncLock } from "./sync-lock.js";
import { categoryOf, findStatus, loadWorkflow } from "./workflow.js";

// ── the normalised record ─────────────────────────────────────────

/** A timestamp in any form a tracker sends (Jira: `2026-10-22T09:14:00.000+0000`), as ISO UTC. */
const WhenZ = z
  .string()
  .transform((s) => s.trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2"))
  .refine((s) => Number.isFinite(Date.parse(s)), "not a timestamp")
  .transform((s) => new Date(s).toISOString());

export const IngestCommentZ = z.object({
  /** The tracker's comment id; the activity row carries `<provider>-c-<id>`. */
  id: z.string().min(1),
  author: z.string().min(1),
  /** Markdown (a source converts its own rich text first). */
  body: z.string(),
  created: WhenZ,
  updated: WhenZ.optional(),
});
export type IngestComment = z.infer<typeof IngestCommentZ>;

/** What the record says about the issue's status in the tracker. `category` lets ingest derive
 *  `state` before the workspace's workflow knows the status. */
export const IngestStatusZ = z.object({
  /** The workflow status id, as the source names it (`jira:10001`). */
  id: z.string().min(1),
  name: z.string().min(1),
  category: IssueStateZ,
});

/** The tracker-owned part of `external` a record carries; `provider`, `source`, `syncedAt` and
 *  `archived` are ingest's to set. */
const IngestExternalZ = ExternalRefZ.omit({ provider: true, source: true, remoteStatus: true, remoteUpdated: true, syncedAt: true, archived: true })
  .extend({
    key: z.string().regex(ISSUE_ID_RE).refine((k) => !k.includes("."), "a tracker key is never dotted"),
    assignee: ExternalUserZ.nullable().optional(),
    reporter: ExternalUserZ.nullable().optional(),
    /** The tracker's own `updated`. Compared only with itself, never the local clock. */
    remoteUpdated: WhenZ.optional(),
  })
  .loose();

/**
 * One issue as a source read it. A full record has `title` and `status`; a record with only
 * `external.id`/`key` and `archived` says the issue left scope, was deleted or can't be read
 * any more (it is archived, never deleted).
 */
export const IngestRecordZ = z
  .object({
    external: IngestExternalZ,
    title: z.string().min(1).optional(),
    /** Markdown. Absent leaves the description as it is; empty clears it. */
    description: z.string().nullable().optional(),
    status: IngestStatusZ.optional(),
    labels: z.array(z.string()).optional(),
    acceptanceCriteria: z.array(AcceptanceItemZ).optional(),
    comments: z.array(IngestCommentZ).optional(),
    archived: ExternalArchivedZ.pick({ reason: true }).optional(),
  })
  .refine((r) => r.archived || (r.title && r.status), "a record needs `title` and `status` unless it is `archived`");
export type IngestRecord = z.infer<typeof IngestRecordZ>;

export interface IngestConflict {
  id: string;
  /** The status hive has, and the one the tracker moved to. */
  local: string;
  remote: string;
}

export interface IngestReport {
  source: string;
  dryRun: boolean;
  created: string[];
  updated: string[];
  unchanged: string[];
  conflicts: IngestConflict[];
  archived: string[];
  /** Things worth telling the person: a stale lock taken over, a done issue with a PR left open. */
  notes: string[];
}

// ── the ledger ────────────────────────────────────────────────────

interface LedgerEntry {
  id: string;
  remoteUpdated?: string;
  /** Hash of the last record applied, and of the tracker-owned fields as last written. */
  remoteHash: string;
  localHash: string;
  /** The status base for the conflict rule (§8.3): the tracker's status and hive's, as last synced. */
  remoteStatus?: string;
  localStatus?: string;
  conflict?: IngestConflict & { since: string };
  /** Comment id → hash of its body as last applied, so an edit is seen without re-reading rows. */
  comments?: Record<string, string>;
}

interface Ledger {
  version: 1;
  source: string;
  entries: Record<string, LedgerEntry>;
}

const ledgerPath = (root: string, source: string): string => path.join(syncDir(root, source), "ledger.json");

async function readLedger(root: string, source: string): Promise<Ledger> {
  try {
    const l = JSON.parse(await fs.readFile(ledgerPath(root, source), "utf8")) as Ledger;
    if (l?.version === 1 && l.entries && typeof l.entries === "object") return { version: 1, source, entries: l.entries };
  } catch {
    /* none yet, or unreadable: the mirrored files still say what was synced */
  }
  return { version: 1, source, entries: {} };
}

// ── helpers ───────────────────────────────────────────────────────

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, stable(x)]));
  }
  return v;
}
const hash = (v: unknown): string => createHash("sha256").update(JSON.stringify(stable(v))).digest("hex").slice(0, 16);

/** Escape lines of tracker text that hive would read as its own structure. */
const HEADING = /^(\s*)(#{1,6}\s)/;
const ACTIVITY_ROW = /^(\s*)(-\s+\S+\s+·\s)/;
const quoteText = (text: string): string =>
  text.split("\n").map((l) => l.replace(HEADING, "$1\\$2").replace(ACTIVITY_ROW, "$1\\$2")).join("\n");
/** A single line, with no `·` (the activity row's separator). */
const oneLine = (s: string): string => s.replace(/\s+/g, " ").replace(/·/g, "-").trim();

/** Everything ingest writes, for telling "changed" from "unchanged" (the write's own timestamps excluded). */
function projection(i: Issue): unknown {
  const { syncedAt: _s, ...external } = i.external ?? ({} as ExternalRef);
  return {
    id: i.id, title: i.title, state: i.state, status: i.status, parent: i.parent, labels: i.labels,
    aliases: i.aliases, external, sections: i.sections,
  };
}

function trackerFields(i: Issue): unknown {
  const { syncedAt: _s, archived: _a, ...external } = i.external ?? ({} as ExternalRef);
  return { title: i.title, description: i.sections.description, labels: i.labels, parent: i.parent, external };
}

/** Acceptance criteria from the tracker, keeping hive's ticks for items whose text is unchanged. */
function mergeAcceptance(local: Issue["sections"]["acceptanceCriteria"], remote: IngestRecord["acceptanceCriteria"] & object) {
  const done = new Map(local.map((a) => [a.text, a.done]));
  return remote.map((a) => ({ done: done.get(quoteText(oneLine(a.text))) ?? a.done, text: quoteText(oneLine(a.text)) }));
}

interface StatusBase { remote?: string; local?: string }

/**
 * The status conflict rule (design §8.3). `base` is the tracker's and hive's status as last synced.
 * Returns the status hive keeps, the new base, and a conflict when both sides moved apart.
 */
function resolveStatus(o: {
  remote: string;
  local: string;
  base: StatusBase;
  /** The tracker status a hive-only status follows, if it does. */
  follows?: string;
  remoteClosed: boolean;
  localWork: boolean;
}): { take: "remote" | "local"; base: StatusBase; conflict?: { local: string; remote: string }; note?: string } {
  const { remote, local, base } = o;
  if (base.remote === undefined) return { take: "remote", base: { remote, local: remote } };
  const remoteMoved = remote !== base.remote;
  const localMoved = local !== base.local;
  if (!localMoved) return { take: "remote", base: { remote, local: remote } };
  if (!remoteMoved) return { take: "local", base }; // hive's move waits to be pushed
  if (local === remote) return { take: "remote", base: { remote, local: remote } };
  if (o.follows === remote) return { take: "local", base: { remote, local } };
  if (o.remoteClosed && o.localWork) {
    return { take: "remote", base: { remote, local: remote }, note: "closed in the tracker while work exists here; the branch and PR are left as they are" };
  }
  return { take: "local", base, conflict: { local, remote } };
}

// ── ingest ────────────────────────────────────────────────────────

export interface IngestOptions {
  /** Work out the report and write nothing: no file, ledger, config or lock. */
  dryRun?: boolean;
}

/**
 * Upsert `records` into the mirror of `source` (`jira:acme/PAY`) in the workspace at `root`, by
 * (source, external.id). Records are validated first; one that doesn't parse writes nothing. Holds
 * the source's sync lock while it writes.
 */
export async function ingestRecords(root: string, source: string, records: readonly unknown[], opts: IngestOptions = {}): Promise<IngestReport> {
  const provider = /^([a-z][a-z0-9-]*):\S/.exec(source)?.[1];
  if (!provider) throw new HiveError("invalid_arg", `a source id is <provider>:<where>, e.g. jira:acme/PAY (got ${JSON.stringify(source)})`);
  mirrorDir(root, source); // a source with no usable folder name throws here, before anything is written

  const parsed: IngestRecord[] = records.map((r, i) => {
    const res = IngestRecordZ.safeParse(r);
    if (!res.success) throw new HiveError("bad_request", `record ${i + 1}: ${z.prettifyError(res.error)}`);
    return res.data;
  });
  const cfg = await readConfig(root);
  const prefixes = [...new Set(parsed.map((r) => issuePrefix(r.external.key)!))];
  if (prefixes.includes(cfg.prefix)) {
    throw new HiveError("prefix_clash", `${source} mirrors ${cfg.prefix}, which is this workspace's own prefix — mirror it into a workspace with another prefix`);
  }
  const bad = prefixes.find((p) => !EXTERNAL_PREFIX_RE.test(p));
  if (bad) throw new HiveError("bad_request", `not a tracker key prefix: ${bad}`);

  await refuseSharedFolder(root, source);

  const report: IngestReport = { source, dryRun: !!opts.dryRun, created: [], updated: [], unchanged: [], conflicts: [], archived: [], notes: [] };
  if (opts.dryRun) {
    await apply(root, source, provider, parsed, report, false);
    return report;
  }
  return withSyncLock(
    root,
    source,
    async () => {
      // Routing first: a prefix registered with no files yet is harmless; files no id reaches are not.
      await ignoreSyncFolders(root, { commitMirror: cfg.mirror?.commit === true });
      const known = new Set(cfg.external_prefixes ?? []);
      if (prefixes.some((p) => !known.has(p))) {
        await updateConfig(root, (c) => ({ ...c, external_prefixes: [...new Set([...(c.external_prefixes ?? []), ...prefixes])] }));
        await registerWorkspace(root).catch(() => {}); // the registry is an index; routing still works from inside
      }
      await apply(root, source, provider, parsed, report, true);
      return report;
    },
    { onTakeover: (n) => report.notes.push(n) },
  );
}

/**
 * Two source ids that differ only in punctuation (`jira:acme/PAY`, `jira:acme-PAY`) have the same
 * folder name. A folder is one source's: the ledger and the mirrored files say whose, and another
 * source is refused rather than mixed into it.
 */
async function refuseSharedFolder(root: string, source: string): Promise<void> {
  let owner: string | undefined;
  try {
    const l = JSON.parse(await fs.readFile(ledgerPath(root, source), "utf8")) as { source?: unknown };
    if (typeof l?.source === "string" && l.source !== source) owner = l.source;
  } catch {
    /* no ledger yet */
  }
  if (!owner) {
    const dir = mirrorDir(root, source) + path.sep;
    for (const [p, e] of await scanIssueFiles(root)) {
      if (p.startsWith(dir) && e.external && e.external.source !== source) { owner = e.external.source; break; }
    }
  }
  if (owner) {
    throw new HiveError(
      "slug_taken",
      `${source} would share the folder ${path.basename(mirrorDir(root, source))} with ${owner}, which already syncs into it — name this source with an id that differs from ${owner} in more than punctuation`,
    );
  }
}

const SWAP_ATTEMPTS = 3;

/**
 * Put `text` in `file` (through a temp file and a rename, so no reader sees half of it), but only
 * if `holder` — the file the issue was read from — still holds `expected`; with no holder, only if
 * `file` doesn't exist yet. Checked after the temp file is written, right before the rename, so
 * the window left for a write to slip in is that one step. Returns whether it was written.
 */
async function swapIn(file: string, text: string, holder: string | undefined, expected: string | undefined): Promise<boolean> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    await fs.writeFile(tmp, text, "utf8");
    const now = await fs.readFile(holder ?? file, "utf8").catch(() => undefined);
    if (holder ? now !== expected : now !== undefined) {
      await fs.rm(tmp, { force: true });
      return false;
    }
    await fs.rename(tmp, file);
    return true;
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

async function apply(root: string, source: string, provider: string, records: IngestRecord[], report: IngestReport, write: boolean): Promise<void> {
  const dir = mirrorDir(root, source);
  const ledger = await readLedger(root, source);
  const wf = loadWorkflow(root);
  // The sync identity as the files hold it — the ledger may be behind a sync that was killed.
  const byExternal = new Map<string, string[]>();
  for (const [p, e] of await scanIssueFiles(root)) {
    if (e.external?.source !== source) continue;
    byExternal.set(e.external.id, [...(byExternal.get(e.external.id) ?? []), p]);
  }
  /** What this run wrote (or, dry, would have), so a later record of the same issue reads it. */
  const written = new Map<string, Issue>();
  const now = () => new Date().toISOString();
  const who = provider;

  records: for (const rec of records) {
    const extId = rec.external.id;
    const paths = byExternal.get(extId) ?? [];
    const entry = ledger.entries[extId];

    // A hive write (an update, a comment) can land between reading the issue and renaming the new
    // file over it. The rename happens only if the file still reads as it did; otherwise the record
    // is applied again to what is there now, a few times at most.
    for (let attempt = 0; ; attempt++) {
      // Read what is there. More than one file holds this issue only when a key move was killed
      // between writing the new file and removing the old. Either one will do: the records replay
      // from there to the same end, and the others are removed once the issue is written.
      const primary = paths.find((p) => path.basename(p) === `${rec.external.key}.md`) ?? paths[0];
      const beforeRaw = primary && (write || !written.has(primary)) ? await fs.readFile(primary, "utf8") : undefined;
      const before: Issue | null = primary ? (beforeRaw !== undefined ? parseIssueFile(primary, beforeRaw) : written.get(primary)!) : null;
      const leftovers = paths.filter((p) => p !== primary);

      // A record older than what was already applied changes nothing the tracker owns — not even the
      // key — so replaying a sequence, in any order, ends where its newest records put it.
      const highWater = [entry?.remoteUpdated, before?.external?.remoteUpdated].filter(Boolean).sort().pop();
      const stale = !!before && !!highWater && !!rec.external.remoteUpdated && rec.external.remoteUpdated < highWater;
      // Only a full, current record moves the key: an archive record names whatever key it last saw.
      const key = before && (stale || !rec.title) ? before.id : rec.external.key;
      const target = path.join(dir, `${key}.md`);

      if (!before && rec.archived) {
        report.unchanged.push(key); // never mirrored: nothing to archive
        continue records;
      }
      if (!before) {
        try {
          await fs.stat(target);
          // A file under this key that is not this issue: a key the tracker gave to another issue.
          report.conflicts.push({ id: key, local: "another issue holds this key", remote: extId });
          continue records;
        } catch {
          /* free */
        }
      }

      const at = now();
      const issue: Issue = before
        ? structuredClone(before)
        : {
            id: key, title: rec.title!, state: rec.status!.category, parent: null, labels: [], assignee: null, github: null,
            created: at, updated: at, path: target, raw: "",
            sections: { description: "", acceptanceCriteria: [], activity: [], extra: "" },
          };
      issue.path = target;
      let conflict: IngestConflict | undefined;
      let base: StatusBase = entry ? { remote: entry.remoteStatus, local: entry.localStatus } : { remote: before?.external?.remoteStatus, local: before?.external?.remoteStatus };
      let comments = { ...(entry?.comments ?? {}) };
      const notes: string[] = [];

      // A key move: same external.id, new key. The old key stays reachable as an alias; the branch is
      // left alone (it was named after the old key, and git knows it by that name).
      for (const old of [before?.id, ...leftovers.map((p) => path.basename(p, ".md"))]) {
        if (!old || old === key) continue;
        issue.aliases = [...new Set([...(issue.aliases ?? []), old])];
        if (old === before?.id) appendActivity(issue, who, `key changed: ${old} → ${key}`);
      }
      if (issue.aliases) {
        issue.aliases = issue.aliases.filter((a) => a !== key);
        if (issue.aliases.length === 0) delete issue.aliases;
      }
      issue.id = key;

      if (rec.title && rec.status && !stale) {
        const { remoteUpdated, ...ext } = rec.external;
        issue.title = oneLine(rec.title);
        if (rec.description !== undefined) issue.sections.description = quoteText((rec.description ?? "").trim());
        if (rec.labels) issue.labels = rec.labels.map(oneLine);
        issue.parent = ext.parentKey ?? null;
        if (rec.acceptanceCriteria) issue.sections.acceptanceCriteria = mergeAcceptance(issue.sections.acceptanceCriteria, rec.acceptanceCriteria);
        issue.external = {
          ...ext,
          provider,
          source,
          remoteStatus: rec.status.id,
          ...(remoteUpdated ? { remoteUpdated } : {}),
          ...(before?.external?.syncedAt ? { syncedAt: before.external.syncedAt } : {}),
          archived: null,
        };

        const local = before ? (before.status ?? before.state) : rec.status.id;
        const s = resolveStatus({
          remote: rec.status.id,
          local,
          base,
          follows: (() => {
            const j = findStatus(wf, local)?.jira;
            return j && j !== "stay" ? j.follow : undefined;
          })(),
          remoteClosed: rec.status.category === "done" || rec.status.category === "cancelled",
          localWork: !!(before?.branch || before?.pr),
        });
        if (s.take === "remote") {
          issue.status = rec.status.id;
          issue.state = categoryOf(wf, rec.status.id) ?? rec.status.category;
        }
        base = s.base;
        if (s.note) {
          appendActivity(issue, who, s.note);
          notes.push(`${key}: ${s.note}`);
        }
        if (s.conflict) conflict = { id: key, ...s.conflict };

        for (const c of [...(rec.comments ?? [])].sort((a, b) => (a.created < b.created ? -1 : 1))) {
          const rowId = `${provider}-c-${c.id}`;
          const body = quoteText(c.body.trim());
          const h = hash(body);
          const row = issue.sections.activity.find((a) => a.id === rowId);
          // An edit is told by the ledger's hash, not by comparing with the row as read back.
          if (row && comments[c.id] && comments[c.id] !== h) row.message = body;
          if (!row) appendActivity(issue, `${oneLine(c.author)} (${provider})`, body, new Date(c.created), rowId);
          comments[c.id] = h;
        }
      }

      // Archived is a state, not an event: no activity row, so leaving and re-entering scope replays
      // to the same file.
      if (rec.archived && issue.external && issue.external.archived?.reason !== rec.archived.reason) {
        issue.external = { ...issue.external, archived: { reason: rec.archived.reason, at } };
      }

      const changed = !before || leftovers.length > 0 || hash(projection(issue)) !== hash(projection(before));
      if (changed) {
        issue.updated = at;
        issue.external = { ...issue.external!, syncedAt: at };
        if (write) {
          if (!(await swapIn(target, serializeIssue(issue), primary, beforeRaw))) {
            if (attempt < SWAP_ATTEMPTS - 1) continue;
            report.notes.push(`${key}: kept changing here while it was synced; left as it is until the next sync`);
            continue records;
          }
          // Only once the issue is safe under its key: the files it moved from, and any a killed move left.
          for (const p of [primary, ...leftovers]) if (p && p !== target) await fs.rm(p, { force: true });
        }
        written.set(target, issue);
        const archivedNow = !!rec.archived && before?.external?.archived?.reason !== rec.archived.reason;
        (archivedNow ? report.archived : before ? report.updated : report.created).push(key);
      } else {
        report.unchanged.push(key);
      }
      if (conflict) report.conflicts.push(conflict);
      report.notes.push(...notes);
      byExternal.set(extId, [target]);

      ledger.entries[extId] = {
        id: key,
        ...((issue.external?.remoteUpdated ?? highWater) ? { remoteUpdated: (issue.external?.remoteUpdated ?? highWater)! } : {}),
        remoteHash: hash(rec),
        localHash: hash(trackerFields(issue)),
        ...(base.remote !== undefined ? { remoteStatus: base.remote } : {}),
        ...(base.local !== undefined ? { localStatus: base.local } : {}),
        ...(conflict ? { conflict: { ...conflict, since: entry?.conflict?.since ?? at } } : {}),
        ...(Object.keys(comments).length ? { comments } : {}),
      };
      break;
    }
  }
  if (write) await writeFileAtomic(ledgerPath(root, source), JSON.stringify(ledger, null, 2) + "\n");
}

export type { IssueState };
