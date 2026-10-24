// A fixture Jira site: the model the fake server answers from. Responses are derived from it
// (and change as the tests transition, assign and comment), so one model covers every endpoint
// the sync uses instead of a canned body per call. Field shapes follow Atlassian's OpenAPI specs
// (Cloud platform v3, Software, DC 11.3); see ../fixtures/README.md for provenance.
import { z } from "zod";

const Id = z.string().regex(/^\d+$/);

/** Jira's status categories. `undefined` is "No Category"; the mapper must tolerate it. */
export const StatusCategoryZ = z.object({
  id: z.number().int(),
  key: z.enum(["new", "indeterminate", "done", "undefined"]),
  colorName: z.string(),
  name: z.string(),
});

export const StatusZ = z.object({
  id: Id,
  name: z.string(),
  statusCategory: StatusCategoryZ,
  /** Project id for a team-managed (project-scoped) status; absent for a global one. */
  scopeProjectId: Id.optional(),
});

export const UserZ = z.object({
  /** Cloud identity. Data Center users have `name`/`key` instead. */
  accountId: z.string().optional(),
  name: z.string().optional(),
  key: z.string().optional(),
  displayName: z.string(),
  emailAddress: z.string().nullable().optional(),
  timeZone: z.string().optional(),
  active: z.boolean().default(true),
});

const FieldMetaZ = z.object({
  required: z.boolean(),
  name: z.string(),
  schema: z.object({ type: z.string(), system: z.string().optional(), custom: z.string().optional() }),
  allowedValues: z.array(z.object({ id: z.string().optional(), name: z.string() })).optional(),
  hasDefaultValue: z.boolean().default(false),
  operations: z.array(z.string()).default(["set"]),
});

export const TransitionZ = z.object({
  id: Id,
  name: z.string(),
  /** Status ids this transition leaves from; `"*"` is a global transition. */
  from: z.union([z.literal("*"), z.array(Id).min(1)]),
  to: Id,
  hasScreen: z.boolean().default(false),
  /** Screen fields, as `GET transitions?expand=transitions.fields` reports them. */
  fields: z.record(z.string(), FieldMetaZ).default({}),
  /**
   * A field a validator demands that is NOT on the screen: the POST answers 400 with
   * `errors[field] = message`, which is the only way a client learns about it.
   */
  hiddenRequired: z.record(z.string(), z.string()).optional(),
  /** A condition. Unmet → absent from the list (or `isAvailable:false` with includeUnavailable). */
  condition: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("assigneeOnly") }),
      z.object({ kind: z.literal("users"), allow: z.array(z.string()) }),
    ])
    .optional(),
});

export const WorkflowZ = z.object({
  name: z.string(),
  statuses: z.array(Id).min(1),
  initial: Id,
  transitions: z.array(TransitionZ),
});

export const IssueTypeZ = z.object({
  id: Id,
  name: z.string(),
  subtask: z.boolean(),
  hierarchyLevel: z.number().int(),
  workflow: z.string(),
});

export const ProjectZ = z.object({
  id: Id,
  key: z.string(),
  name: z.string(),
  /** `classic` = company-managed, `next-gen` = team-managed. */
  style: z.enum(["classic", "next-gen"]),
  simplified: z.boolean(),
  projectTypeKey: z.enum(["software", "business", "service_desk"]),
  /** Every key the project has had (GET project?expand=projectKeys). */
  projectKeys: z.array(z.string()).optional(),
  archived: z.boolean().default(false),
  issueTypes: z.array(IssueTypeZ).min(1),
});

export const FieldZ = z.object({
  id: z.string(),
  key: z.string().optional(),
  name: z.string(),
  custom: z.boolean(),
  schema: z.object({ type: z.string(), items: z.string().optional(), system: z.string().optional(), custom: z.string().optional(), customId: z.number().optional() }).optional(),
  clauseNames: z.array(z.string()).default([]),
  /** Team-managed fields are scoped to one project. */
  scopeProjectId: Id.optional(),
});

export const BoardZ = z.object({
  id: z.number().int(),
  name: z.string(),
  type: z.enum(["scrum", "kanban", "simple"]),
  projectKey: z.string(),
  /** `shared: false` = the filter isn't shared with myself: GET filter/{id} refuses it (design §6.1). */
  filter: z.object({ id: Id, jql: z.string(), shared: z.boolean().default(true) }),
  /** Kanban only: the board's sub-filter (hides done work after N days by default). */
  subQuery: z.string().optional(),
  columns: z.array(z.object({ name: z.string(), statuses: z.array(Id), min: z.number().optional(), max: z.number().optional() })).min(1),
  /** Kanban with the backlog enabled: the backlog is the FIRST column's statuses. */
  kanbanBacklog: z.boolean().default(false),
  estimationFieldId: z.string().optional(),
  rankFieldId: z.number().int().optional(),
  features: z.record(z.string(), z.enum(["ENABLED", "DISABLED", "COMING_SOON"])).default({}),
});

export const SprintZ = z.object({
  id: z.number().int(),
  boardId: z.number().int(),
  name: z.string(),
  state: z.enum(["active", "future", "closed"]),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  goal: z.string().optional(),
});

const RichTextZ = z.union([z.object({ adf: z.unknown() }), z.object({ wiki: z.string() })]);

export const CommentZ = z.object({
  id: Id,
  author: z.string(),
  body: RichTextZ,
  created: z.string(),
  updated: z.string(),
  /** A restricted comment: visible only to this role/group. */
  visibility: z.object({ type: z.enum(["role", "group"]), value: z.string() }).optional(),
});

export const ChangeZ = z.object({
  id: Id,
  author: z.string(),
  created: z.string(),
  items: z.array(
    z.object({
      field: z.string(),
      fieldId: z.string().optional(),
      from: z.string().nullable(),
      fromString: z.string().nullable(),
      to: z.string().nullable(),
      toString: z.string().nullable(),
    }),
  ),
});

export const IssueZ = z.object({
  id: Id,
  key: z.string(),
  /** Earlier keys, oldest first, for an issue moved between projects. */
  previousKeys: z.array(z.string()).default([]),
  project: z.string(),
  issueType: Id,
  status: Id,
  summary: z.string(),
  description: RichTextZ.nullable(),
  /** user reference: Cloud accountId, DC username. null = unassigned. */
  assignee: z.string().nullable(),
  reporter: z.string(),
  priority: z.string(),
  resolution: z.string().nullable().default(null),
  labels: z.array(z.string()).default([]),
  components: z.array(z.string()).default([]),
  fixVersions: z.array(z.string()).default([]),
  parent: z.string().optional(),
  sprints: z.array(z.number().int()).default([]),
  flagged: z.boolean().default(false),
  estimate: z.number().optional(),
  /** Custom field values by field id (AC text, team, …). */
  custom: z.record(z.string(), z.unknown()).default({}),
  links: z
    .array(z.object({ type: z.enum(["Blocks", "Relates", "Duplicate", "Cloners"]), direction: z.enum(["inward", "outward"]), key: z.string() }))
    .default([]),
  created: z.string(),
  updated: z.string(),
  comments: z.array(CommentZ).default([]),
  changelog: z.array(ChangeZ).default([]),
  properties: z.record(z.string(), z.unknown()).default({}),
  remoteLinks: z.array(z.object({ id: z.number().int(), globalId: z.string().optional(), object: z.object({ url: z.string(), title: z.string() }).passthrough() })).default([]),
  /** Hidden by an issue security level: absent from search, 404 from GET, omitted by bulkfetch. */
  restricted: z.boolean().default(false),
  /** Deleted: same observable behaviour as restricted (Jira has no tombstone). */
  deleted: z.boolean().default(false),
});

/** A scripted failure: the Nth matching request (1-based) gets this response instead. */
export const FaultZ = z.object({
  name: z.string(),
  match: z.object({ method: z.string(), path: z.string(), nth: z.number().int().min(1).default(1), times: z.number().int().min(1).default(1) }),
  status: z.number().int(),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.unknown().optional(),
});

export const SiteZ = z.object({
  name: z.string(),
  description: z.string(),
  deployment: z.enum(["Cloud", "DataCenter"]),
  /** REST platform version the site answers on: Cloud uses 3 (and 2 for wiki markup), DC only 2. */
  restVersion: z.union([z.literal(2), z.literal(3)]),
  baseUrl: z.string().url(),
  cloudId: z.string().optional(),
  serverInfo: z.object({ version: z.string(), versionNumbers: z.array(z.number()), buildNumber: z.number(), serverTimeZone: z.string() }),
  /** The user the credentials belong to. */
  myself: z.string(),
  users: z.array(UserZ).min(1),
  /** Project permissions of `myself`, by project key (GET mypermissions). */
  permissions: z.record(z.string(), z.array(z.string())),
  statuses: z.array(StatusZ).min(1),
  workflows: z.record(z.string(), WorkflowZ),
  projects: z.array(ProjectZ).min(1),
  resolutions: z.array(z.object({ id: Id, name: z.string(), isDefault: z.boolean().default(false) })),
  priorities: z.array(z.object({ id: Id, name: z.string() })),
  fields: z.array(FieldZ),
  boards: z.array(BoardZ).default([]),
  sprints: z.array(SprintZ).default([]),
  issues: z.array(IssueZ),
  faults: z.array(FaultZ).default([]),
});

export type Site = z.infer<typeof SiteZ>;
export type SiteIssue = z.infer<typeof IssueZ>;
export type SiteTransition = z.infer<typeof TransitionZ>;

/** Referential checks zod can't express. Returns human-readable problems (empty = consistent). */
export function siteProblems(site: Site): string[] {
  const out: string[] = [];
  const statusIds = new Set(site.statuses.map((s) => s.id));
  const userRefs = new Set(site.users.flatMap((u) => [u.accountId, u.name].filter(Boolean) as string[]));
  const keys = new Set(site.issues.map((i) => i.key));
  const projects = new Map(site.projects.map((p) => [p.key, p]));
  const sprintIds = new Set(site.sprints.map((s) => s.id));

  if (!userRefs.has(site.myself)) out.push(`myself ${site.myself} is not a user`);
  for (const [name, wf] of Object.entries(site.workflows)) {
    for (const s of wf.statuses) if (!statusIds.has(s)) out.push(`workflow ${name}: unknown status ${s}`);
    if (!wf.statuses.includes(wf.initial)) out.push(`workflow ${name}: initial ${wf.initial} not in workflow`);
    const ids = new Set<string>();
    for (const t of wf.transitions) {
      if (ids.has(t.id)) out.push(`workflow ${name}: duplicate transition id ${t.id}`);
      ids.add(t.id);
      if (!wf.statuses.includes(t.to)) out.push(`workflow ${name}: transition ${t.id} targets ${t.to} outside the workflow`);
      if (t.from !== "*") for (const f of t.from) if (!wf.statuses.includes(f)) out.push(`workflow ${name}: transition ${t.id} from ${f} outside the workflow`);
      if (Object.keys(t.fields).length > 0 && !t.hasScreen) out.push(`workflow ${name}: transition ${t.id} has fields but no screen`);
    }
  }
  for (const p of site.projects) {
    for (const t of p.issueTypes) if (!site.workflows[t.workflow]) out.push(`project ${p.key}: type ${t.name} uses unknown workflow ${t.workflow}`);
  }
  for (const b of site.boards) {
    if (!projects.has(b.projectKey)) out.push(`board ${b.id}: unknown project ${b.projectKey}`);
    for (const c of b.columns) for (const s of c.statuses) if (!statusIds.has(s)) out.push(`board ${b.id}: column ${c.name} has unknown status ${s}`);
  }
  for (const s of site.sprints) if (!site.boards.some((b) => b.id === s.boardId && b.type === "scrum")) out.push(`sprint ${s.id}: not on a scrum board`);
  for (const i of site.issues) {
    const p = projects.get(i.project);
    if (!p) { out.push(`${i.key}: unknown project ${i.project}`); continue; }
    if (!i.key.startsWith(`${p.key}-`)) out.push(`${i.key}: key does not match project ${p.key}`);
    const type = p.issueTypes.find((t) => t.id === i.issueType);
    if (!type) { out.push(`${i.key}: type ${i.issueType} not in project ${p.key}`); continue; }
    const wf = site.workflows[type.workflow];
    if (wf && !wf.statuses.includes(i.status)) out.push(`${i.key}: status ${i.status} not in workflow ${type.workflow}`);
    if (i.assignee !== null && !userRefs.has(i.assignee)) out.push(`${i.key}: unknown assignee ${i.assignee}`);
    if (!userRefs.has(i.reporter)) out.push(`${i.key}: unknown reporter ${i.reporter}`);
    if (i.parent && !keys.has(i.parent)) out.push(`${i.key}: unknown parent ${i.parent}`);
    if (type.subtask && !i.parent) out.push(`${i.key}: sub-task without a parent`);
    for (const l of i.links) if (!keys.has(l.key)) out.push(`${i.key}: link to unknown ${l.key}`);
    for (const s of i.sprints) if (!sprintIds.has(s)) out.push(`${i.key}: unknown sprint ${s}`);
    for (const c of i.comments) if (!userRefs.has(c.author)) out.push(`${i.key}: comment ${c.id} by unknown ${c.author}`);
    if (site.deployment === "DataCenter" && i.description && "adf" in i.description) out.push(`${i.key}: Data Center descriptions are wiki markup, not ADF`);
    if (Date.parse(i.updated) < Date.parse(i.created)) out.push(`${i.key}: updated before created`);
  }
  return out;
}
