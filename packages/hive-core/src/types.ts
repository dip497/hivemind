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

/** YAML frontmatter schema for an issue file. */
export const IssueFrontmatterZ = z.object({
  id: z.string().regex(/^[A-Z][A-Z0-9]{1,9}-\d+(\.\d+)*$/),
  title: z.string().min(1),
  state: IssueStateZ.default("backlog"),
  parent: z.string().nullable().default(null),
  labels: z.array(z.string()).default([]),
  assignee: AssigneeZ.nullable().default(null),
  github: z.number().int().positive().nullable().default(null),
  cycle: z.string().nullable().default(null),
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
  at: string; // ISO
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
    | "cycle"
    | "created"
    | "updated"
  > {
  path: string;
}

export const CycleFrontmatterZ = z.object({
  id: z.string().regex(/^cycle-\d+$/),
  name: z.string(),
  start_at: IsoZ.nullable().default(null),
  end_at: IsoZ.nullable().default(null),
  state: z.enum(["upcoming", "active", "completed"]).default("upcoming"),
  issues: z.array(z.string()).default([]),
});
export type CycleFrontmatter = z.infer<typeof CycleFrontmatterZ>;
export interface Cycle extends CycleFrontmatter {
  path: string;
  raw: string;
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
