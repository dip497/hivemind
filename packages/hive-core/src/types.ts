import { z } from "zod";

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

/** Full issue id incl. dotted sub-issues — `PAY-42`, `PAY-1.2.3`. The prefix
 *  (chars before `-`) names the workspace, so a full id is globally unique and
 *  is itself the cross-repo address — no extra repo qualifier needed. */
export const IssueIdZ = z.string().regex(/^[A-Z][A-Z0-9]{1,9}-\d+(\.\d+)*$/);

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

/** YAML frontmatter schema for an issue file. */
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
  created: IsoZ,
  updated: IsoZ,
});
export type IssueFrontmatter = z.infer<typeof IssueFrontmatterZ>;

/** Body sections parsed out from the markdown. */
export interface IssueSections {
  description: string;
  acceptanceCriteria: AcceptanceItem[];
  activity: ActivityEntry[];
  /** Untouched body text for sections we don't model yet. */
  extra: string;
}

export interface AcceptanceItem {
  done: boolean;
  text: string;
}

export interface ActivityEntry {
  /** Always a parseable ISO-with-Z string after `parseActivity` normalization. */
  at: string;
  /** Raw on-disk timestamp form (legacy `YYYY-MM-DD HH:MM` or ISO). When set,
   *  the serializer round-trips it as-is so loading + re-writing an issue
   *  doesn't churn timestamp tokens across the file (would otherwise produce
   *  noisy diffs on the very first updateIssue after upgrade). */
  rawAt?: string;
  who: string; // user id or agent id
  message: string;
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
    | "created"
    | "updated"
  > {
  path: string;
}

export const ConfigZ = z.object({
  prefix: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/, "prefix must be UPPERCASE 2-10 chars"),
  next_id: z.number().int().positive(),
  agents: z
    .record(
      z.string(),
      z.object({
        bin: z.string(),
        model: z.string().optional(),
      })
    )
    .default({}),
});
export type Config = z.infer<typeof ConfigZ>;

/** Common JSON envelope used by all CLI commands when `--json` is passed. */
export type CliResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: string };
