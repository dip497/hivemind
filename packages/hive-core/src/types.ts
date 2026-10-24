import { z } from "zod";
import { ISSUE_ID_RE, LOCAL_PREFIX_RE, EXTERNAL_PREFIX_RE } from "./issue-id.js";

export const IssueStateZ = z.enum([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
]);
export type IssueState = z.infer<typeof IssueStateZ>;

export const AssigneeZ = z.object({
  type: z.enum(["agent", "member"]),
  id: z.string().min(1),
  model: z.string().optional(),
});
export type Assignee = z.infer<typeof AssigneeZ>;

/** ISO-8601 timestamp string (UTC). */
export const IsoZ = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);

/** Full issue id incl. dotted sub-issues — `PAY-42`, `PAY-1.2.3` — or a tracker's key mirrored
 *  as an id (`LONG_KEY-7`; see issue-id.ts). The prefix (chars before `-`) names the workspace or
 *  the mirrored project, so a full id is itself the cross-repo address. */
export const IssueIdZ = z.string().regex(ISSUE_ID_RE);

/** Relationship types for cross-repo (and intra-repo non-parent) links. Each
 *  has a reciprocal recorded on the other end (see `reciprocalLinkType`):
 *  blocks↔blocked-by, parent-of↔child-of, moved-to↔moved-from; relates &
 *  duplicates are symmetric. The `parent` frontmatter field stays the
 *  single-repo hierarchy; these links span repos and express softer links. */
export const LinkTypeZ = z.enum([
  "relates",
  "blocks",
  "blocked-by",
  "duplicates",
  "parent-of",
  "child-of",
  "moved-to",
  "moved-from",
]);
export type LinkType = z.infer<typeof LinkTypeZ>;

export const IssueLinkZ = z.object({
  /** Target issue id (may live in another workspace — resolve via registry). */
  id: IssueIdZ,
  type: LinkTypeZ.default("relates"),
});
export type IssueLink = z.infer<typeof IssueLinkZ>;

/** A person in an external tracker (Jira's assignee or reporter) — not hive's `assignee`. */
export const ExternalUserZ = z
  .object({
    /** Cloud identity; Data Center users have only `name` (their username). */
    accountId: z.string().optional(),
    name: z.string(),
    /** True when this is the person whose credentials the sync uses. */
    me: z.boolean().optional(),
  })
  .loose();
export type ExternalUser = z.infer<typeof ExternalUserZ>;

/** Why a mirrored issue is hidden: hive never deletes one because the tracker stopped returning it. */
export const ExternalArchivedZ = z.object({
  reason: z.enum(["left scope", "deleted", "no access"]),
  at: IsoZ,
});

/** The link from a mirrored issue to the tracker that owns it (design jira-sync §5.1). The tracker
 *  owns every field here; `source` + `id` is the sync identity (keys change when issues move). */
export const ExternalRefZ = z
  .object({
    provider: z.string().min(1),
    /** Which link owns it, e.g. `jira:acme/PAY`. */
    source: z.string().min(1),
    /** The tracker's immutable id (Jira's numeric issue id, as a string). */
    id: z.string().min(1),
    key: z.string().min(1),
    url: z.string().url().optional(),
    type: z.object({ id: z.string(), name: z.string(), hierarchyLevel: z.number().int().optional() }).loose().optional(),
    /** The tracker's status right now, as a workflow status id (may differ from `status`). */
    remoteStatus: z.string().optional(),
    assignee: ExternalUserZ.nullable().optional(),
    reporter: ExternalUserZ.nullable().optional(),
    sprint: z.object({ id: z.number().int(), name: z.string(), state: z.string() }).loose().nullable().optional(),
    priority: z.string().optional(),
    estimate: z.number().optional(),
    parentKey: z.string().optional(),
    /** The tracker's own `updated`, normalised to ISO UTC. Compared only with itself, never the local clock. */
    remoteUpdated: IsoZ.optional(),
    syncedAt: IsoZ.optional(),
    archived: ExternalArchivedZ.nullable().optional(),
  })
  .loose();
export type ExternalRef = z.infer<typeof ExternalRefZ>;

/** The pull request an issue's work went into (design jira-sync §11). */
export const PrRefZ = z
  .object({
    repo: z.string().min(1),
    number: z.number().int().positive(),
    url: z.string().url(),
    state: z.enum(["open", "draft", "merged", "closed"]),
  })
  .loose();
export type PrRef = z.infer<typeof PrRefZ>;

/** YAML frontmatter schema for an issue file. Loose: a key this build doesn't name (one a newer
 *  build or a plugin wrote) is kept and written back after the known ones (`serializeIssue`). */
export const IssueFrontmatterZ = z.object({
  id: IssueIdZ,
  title: z.string().min(1),
  state: IssueStateZ.default("backlog"),
  parent: z.string().nullable().default(null),
  labels: z.array(z.string()).default([]),
  assignee: AssigneeZ.nullable().default(null),
  github: z.number().int().positive().nullable().default(null),
  // Cross-repo / soft links. Optional (not `.default([])`) so existing issue
  // literals and on-disk files without the field stay valid without churn;
  // read it as `issue.links ?? []`.
  links: z.array(IssueLinkZ).optional(),
  /** The workflow status id (design jira-sync §4). `state` is always its category; absent = `state`. */
  status: z.string().min(1).optional(),
  /** Set on issues mirrored from an external tracker. */
  external: ExternalRefZ.optional(),
  /** The git branch this issue's work happens on. */
  branch: z.string().min(1).optional(),
  pr: PrRefZ.optional(),
  /** Earlier ids that still resolve to this issue (a Jira key before the issue moved). */
  aliases: z.array(z.string()).optional(),
  created: IsoZ,
  updated: IsoZ,
}).loose();
export type IssueFrontmatter = z.infer<typeof IssueFrontmatterZ>;

/** Body sections parsed out from the markdown. */
export interface IssueSections {
  description: string;
  acceptanceCriteria: AcceptanceItem[];
  activity: ActivityEntry[];
  /** Sections we don't model, as written: everything from an unknown `#`/`##` heading inside or
   *  after Activity. Written back after Activity. */
  extra: string;
  /** The Acceptance criteria section line by line, present only when it holds more than
   *  checklist items (prose, `* [ ]`, nested bullets, an unknown heading's block, or an indented
   *  item), so those lines survive a rewrite in place. A `{ indent }` slot is where the next entry
   *  of `acceptanceCriteria` goes; entries beyond the slots go at the end of the section. */
  acceptanceLayout?: LayoutLine[];
  /** The same for Activity: lines that are not rows, kept between the rows they sat between. */
  activityLayout?: LayoutLine[];
}

/** A line kept as written, or a slot for the section's next modelled entry. */
export type LayoutLine = string | { indent: string };

export interface AcceptanceItem {
  done: boolean;
  text: string;
}

export interface ActivityEntry {
  /** An ISO-8601 timestamp with `Z` (UTC). */
  at: string;
  who: string; // user id, agent id or a tracker person ("Jane Doe (jira)")
  message: string;
  /** A stable id for a row that mirrors one elsewhere (`jira-c-10023` for a Jira comment), so a
   *  sync matches it instead of adding it twice. Written as a trailing `<!-- id:… -->`. */
  id?: string;
}

export interface Issue extends IssueFrontmatter {
  /** Absolute filesystem path of the issue file. */
  path: string;
  sections: IssueSections;
  /** Raw markdown body (everything after frontmatter). */
  raw: string;
}

/** Lightweight pre-parse view used for fast `list`. */
export interface IssueSummary
  extends Pick<
    IssueFrontmatter,
    | "id"
    | "title"
    | "state"
    | "parent"
    | "labels"
    | "assignee"
    | "github"
    | "links"
    | "status"
    | "external"
    | "branch"
    | "pr"
    | "aliases"
    | "created"
    | "updated"
  > {
  path: string;
}

export const AcceptanceItemZ = z.object({ done: z.boolean(), text: z.string() });

/** Partial update to an issue. The SINGLE source of truth for this shape — both
 *  core's updateIssue and the desktop IPC contract import it from here (it lives
 *  in types.ts, which is node-free, so the web bundle can use it without pulling
 *  storage.ts's node:fs deps). Each field as the issue's file holds it
 *  (`IssueFrontmatterZ`), so a caller's patch is refused before an issue is read
 *  rather than when it is written; parsing drops a field it does not name. */
export const IssuePatchZ = z
  .object({
    title: z.string().min(1),
    state: IssueStateZ,
    /** A workflow status id or name; it sets `state` to its category (design jira-sync §4.3). */
    status: z.string().min(1),
    parent: z.string().nullable(),
    labels: z.array(z.string()),
    assignee: AssigneeZ.nullable(),
    github: z.number().int().positive().nullable(),
    /** `null` removes it, like `github`. */
    branch: z.string().min(1).nullable(),
    pr: PrRefZ.nullable(),
    aliases: z.array(z.string()),
    description: z.string(),
    acceptanceCriteria: z.array(AcceptanceItemZ),
    extra: z.string(),
  })
  .partial();
export type IssuePatch = z.infer<typeof IssuePatchZ>;

/** A new issue as a caller asks for it (core's `createIssue` names who created it). */
export const NewIssueZ = z.object({
  title: z.string(),
  state: IssueStateZ.optional(),
  /** A workflow status id or name; when given, `state` is its category. */
  status: z.string().min(1).optional(),
  parent: IssueIdZ.optional(),
  labels: z.array(z.string()).optional(),
  assignee: AssigneeZ.nullable().optional(),
  description: z.string().optional(),
  acceptanceCriteria: z.array(AcceptanceItemZ).optional(),
  github: z.number().int().positive().nullable().optional(),
  branch: z.string().min(1).optional(),
});
export type NewIssue = z.infer<typeof NewIssueZ>;

/** `.hivemind/config.yaml`. Loose, like the issue frontmatter: every writer keeps keys it doesn't name. */
export const ConfigZ = z.object({
  prefix: z.string().regex(LOCAL_PREFIX_RE, "prefix must be UPPERCASE 2-10 chars"),
  next_id: z.number().int().positive(),
  /** The on-disk format the workspace is at (storage.ts WORKSPACE_FORMAT). */
  format: z.number().int().positive().optional(),
  /** What `hive ctl complete` does (design jira-sync §11.2): open the PR (default), a draft, or only
   *  move the issue to review. */
  on_complete: z.enum(["pr", "draft_pr", "review"]).optional(),
  pr_base: z.string().min(1).optional(),
  /** After a merge: remove the worktree and local branch (`auto`), ask, or keep them. */
  cleanup: z.enum(["ask", "auto", "never"]).optional(),
  /** The branch an issue's work goes on; `{key}` and `{slug}` are filled in. */
  branch_template: z.string().min(1).optional(),
  /** A command `hive ctl complete` runs in the worktree before it hands work on (tests, lint). */
  check: z.string().min(1).optional(),
  /** Tracker project keys mirrored here (`PAY` for `PAY-318`), written by `hive ingest`. */
  external_prefixes: z.array(z.string().regex(EXTERNAL_PREFIX_RE)).optional(),
  /** `commit: true` keeps `.hivemind/mirror/` in git instead of ignoring it (mirror.ts). */
  mirror: z.object({ commit: z.boolean().optional() }).loose().optional(),
  agents: z
    .record(
      z.string(),
      z.object({
        bin: z.string(),
        model: z.string().optional(),
      }).loose()
    )
    .default({}),
}).loose();
export type Config = z.infer<typeof ConfigZ>;

/** Common JSON envelope used by all CLI commands when `--json` is passed. */
export type CliResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: string };
