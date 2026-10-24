// Site model → Jira JSON. Shapes follow the OpenAPI response schemas (Cloud v3 / DC v2); the
// schema check in server.test.ts holds the representative ones to that.
import type { Site, SiteIssue } from "./site.js";

type Json = Record<string, unknown>;
export type Status = Site["statuses"][number];
type User = Site["users"][number];

export interface RenderContext {
  site: Site;
  /** The URL `self` links start with: the fake's origin, plus `/ex/jira/<cloudId>` on the gateway. */
  base: string;
  /** REST platform version of the request: 3 = ADF, 2 = wiki markup / plain text. */
  v: 2 | 3;
}

const cloud = (c: RenderContext) => c.site.deployment === "Cloud";
const avatars = (c: RenderContext, id: string) =>
  Object.fromEntries(["16x16", "24x24", "32x32", "48x48"].map((s) => [s, `${c.base}/secure/useravatar?size=${s}&ownerId=${encodeURIComponent(id)}`]));

export function findUser(site: Site, ref: string | null | undefined): User | undefined {
  if (!ref) return undefined;
  return site.users.find((u) => u.accountId === ref || u.name === ref || u.key === ref);
}

/** The reference an issue stores for a user: accountId on Cloud, username on DC. */
export const userRef = (site: Site, u: User) => (site.deployment === "Cloud" ? u.accountId! : u.name!);

/** UserDetails as embedded in issues, comments and changelogs. */
export function userJson(c: RenderContext, ref: string | null): Json | null {
  const u = findUser(c.site, ref);
  if (!u) return null;
  if (cloud(c)) {
    return {
      self: `${c.base}/rest/api/${c.v}/user?accountId=${u.accountId}`,
      accountId: u.accountId,
      ...(u.emailAddress ? { emailAddress: u.emailAddress } : {}),
      avatarUrls: avatars(c, u.accountId!),
      displayName: u.displayName,
      active: u.active,
      timeZone: u.timeZone ?? c.site.serverInfo.serverTimeZone,
      accountType: u.accountId!.includes(":") ? "app" : "atlassian",
    };
  }
  return {
    self: `${c.base}/rest/api/2/user?username=${u.name}`,
    name: u.name,
    key: u.key,
    ...(u.emailAddress ? { emailAddress: u.emailAddress } : {}),
    avatarUrls: avatars(c, u.name!),
    displayName: u.displayName,
    active: u.active,
    timeZone: u.timeZone ?? c.site.serverInfo.serverTimeZone,
  };
}

export function statusJson(c: RenderContext, s: Status): Json {
  return {
    self: `${c.base}/rest/api/${c.v}/status/${s.id}`,
    description: "",
    iconUrl: `${c.base}/images/icons/statuses/generic.png`,
    name: s.name,
    id: s.id,
    statusCategory: {
      self: `${c.base}/rest/api/${c.v}/statuscategory/${s.statusCategory.id}`,
      id: s.statusCategory.id,
      key: s.statusCategory.key,
      colorName: s.statusCategory.colorName,
      name: s.statusCategory.name,
    },
    ...(s.scopeProjectId ? { scope: { type: "PROJECT", project: { id: s.scopeProjectId } } } : {}),
  };
}

export function issueTypeJson(c: RenderContext, project: Site["projects"][number], t: Site["projects"][number]["issueTypes"][number]): Json {
  return {
    self: `${c.base}/rest/api/${c.v}/issuetype/${t.id}`,
    id: t.id,
    description: "",
    iconUrl: `${c.base}/images/icons/issuetypes/${t.subtask ? "subtask" : "story"}.svg`,
    name: t.name,
    subtask: t.subtask,
    avatarId: 10300,
    ...(cloud(c) ? { hierarchyLevel: t.hierarchyLevel } : {}),
    ...(project.style === "next-gen" ? { entityId: `fake-${project.id}-${t.id}`, scope: { type: "PROJECT", project: { id: project.id } } } : {}),
  };
}

export function projectRefJson(c: RenderContext, p: Site["projects"][number]): Json {
  return {
    self: `${c.base}/rest/api/${c.v}/project/${p.id}`,
    id: p.id,
    key: p.key,
    name: p.name,
    projectTypeKey: p.projectTypeKey,
    simplified: p.simplified,
    avatarUrls: Object.fromEntries(["16x16", "24x24", "32x32", "48x48"].map((s) => [s, `${c.base}/secure/projectavatar?size=${s}&pid=${p.id}`])),
  };
}

// ── Rich text ────────────────────────────────────────────────────────────────────────────────

type RichText = SiteIssue["description"];

/** Plain text of an ADF document: what Cloud's v2 API gives instead (approximated). */
export function adfText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: string; text?: string; attrs?: { text?: string; shortName?: string }; content?: unknown[] };
  if (n.type === "text") return n.text ?? "";
  if (n.type === "mention" || n.type === "status") return n.attrs?.text ?? "";
  if (n.type === "emoji") return n.attrs?.text ?? n.attrs?.shortName ?? "";
  if (n.type === "hardBreak") return "\n";
  const inner = (n.content ?? []).map(adfText);
  return ["doc", "bulletList", "orderedList", "taskList", "panel", "listItem", "mediaSingle"].includes(n.type ?? "") ? inner.filter(Boolean).join("\n") : inner.join("");
}

export function richTextJson(c: RenderContext, t: RichText): unknown {
  if (t === null) return null;
  if ("wiki" in t) return t.wiki;
  return c.v === 3 ? t.adf : adfText(t.adf);
}

/** The minimal ADF a v2 (wiki) write turns into on Cloud. */
export const textToAdf = (s: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: s }] }] });

// ── Fields ───────────────────────────────────────────────────────────────────────────────────

export const SYSTEM_FIELDS: { id: string; name: string; navigable: boolean; multi: boolean; schema: Json }[] = [
  { id: "summary", name: "Summary", navigable: true, multi: false, schema: { type: "string", system: "summary" } },
  { id: "description", name: "Description", navigable: true, multi: false, schema: { type: "string", system: "description" } },
  { id: "status", name: "Status", navigable: true, multi: false, schema: { type: "status", system: "status" } },
  { id: "assignee", name: "Assignee", navigable: true, multi: false, schema: { type: "user", system: "assignee" } },
  { id: "reporter", name: "Reporter", navigable: true, multi: false, schema: { type: "user", system: "reporter" } },
  { id: "priority", name: "Priority", navigable: true, multi: false, schema: { type: "priority", system: "priority" } },
  { id: "issuetype", name: "Issue Type", navigable: true, multi: false, schema: { type: "issuetype", system: "issuetype" } },
  { id: "project", name: "Project", navigable: true, multi: false, schema: { type: "project", system: "project" } },
  { id: "resolution", name: "Resolution", navigable: true, multi: false, schema: { type: "resolution", system: "resolution" } },
  { id: "labels", name: "Labels", navigable: true, multi: true, schema: { type: "array", items: "string", system: "labels" } },
  { id: "components", name: "Components", navigable: true, multi: true, schema: { type: "array", items: "component", system: "components" } },
  { id: "fixVersions", name: "Fix versions", navigable: true, multi: true, schema: { type: "array", items: "version", system: "fixVersions" } },
  { id: "parent", name: "Parent", navigable: true, multi: false, schema: { type: "issuelink", system: "parent" } },
  { id: "subtasks", name: "Sub-tasks", navigable: true, multi: true, schema: { type: "array", items: "issuelinks", system: "subtasks" } },
  { id: "issuelinks", name: "Linked Issues", navigable: true, multi: true, schema: { type: "array", items: "issuelinks", system: "issuelinks" } },
  { id: "attachment", name: "Attachment", navigable: true, multi: true, schema: { type: "array", items: "attachment", system: "attachment" } },
  { id: "comment", name: "Comment", navigable: false, multi: true, schema: { type: "comments-page", system: "comment" } },
  { id: "created", name: "Created", navigable: true, multi: false, schema: { type: "datetime", system: "created" } },
  { id: "updated", name: "Updated", navigable: true, multi: false, schema: { type: "datetime", system: "updated" } },
];

/** Every field an issue in `project` has: system fields plus the site's custom fields in scope. */
export function fieldsFor(site: Site, projectId: string | undefined) {
  const custom = site.fields
    .filter((f) => f.custom && (!f.scopeProjectId || f.scopeProjectId === projectId))
    .map((f) => ({ id: f.id, name: f.name, navigable: true, multi: f.schema?.type === "array", schema: (f.schema ?? { type: "any" }) as Json }));
  return [...SYSTEM_FIELDS, ...custom];
}

export type FieldSelection = { idOnly: true } | { idOnly: false; ids: Set<string> };

/**
 * Resolves a `fields` parameter (repeated and/or comma-separated): `*all`, `*navigable`, explicit
 * ids, `-exclusions`, and `id` / `key` (no field values). Unknown ids are ignored, as Jira does.
 */
export function selectFields(raw: string[] | undefined, dflt: "id" | "*navigable" | "*all", site: Site): FieldSelection {
  const parts = (raw ?? []).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
  const tokens = parts.length ? parts : [dflt];
  const all = fieldsFor(site, undefined).map((f) => f.id).concat(site.fields.filter((f) => f.scopeProjectId).map((f) => f.id));
  const navigable = new Set(fieldsFor(site, undefined).filter((f) => f.navigable).map((f) => f.id).concat(site.fields.filter((f) => f.scopeProjectId).map((f) => f.id)));
  const includes = tokens.filter((t) => !t.startsWith("-"));
  const excludes = new Set(tokens.filter((t) => t.startsWith("-")).map((t) => t.slice(1)));
  let ids = new Set<string>();
  if (includes.includes("*all")) ids = new Set(all);
  else if (includes.includes("*navigable") || includes.length === 0) ids = new Set(navigable);
  for (const t of includes) if (all.includes(t)) ids.add(t);
  for (const t of excludes) ids.delete(t);
  if (ids.size === 0 && includes.every((t) => t === "id")) return { idOnly: true };
  return { idOnly: false, ids };
}

const LINK_TYPES = {
  Blocks: { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" },
  Cloners: { id: "10001", name: "Cloners", inward: "is cloned by", outward: "clones" },
  Duplicate: { id: "10002", name: "Duplicate", inward: "is duplicated by", outward: "duplicates" },
  Relates: { id: "10003", name: "Relates", inward: "relates to", outward: "relates to" },
};

export interface IssueRenderOptions {
  fields: FieldSelection;
  expand: Set<string>;
  properties: string[];
  /** Search and bulkfetch embed at most 20 comments and 40 changelog entries (CHANGE-2046, CHANGE-3413). */
  embedCaps: boolean;
  /** For `expand=transitions`. */
  transitions?: (issue: SiteIssue) => unknown[];
  visible: (issue: SiteIssue) => boolean;
}

export function historyJson(c: RenderContext, h: SiteIssue["changelog"][number]): Json {
  return {
    id: h.id,
    author: userJson(c, h.author),
    created: h.created,
    items: h.items.map((it) => ({
      field: it.field,
      fieldtype: it.fieldId?.startsWith("customfield_") ? "custom" : "jira",
      ...(it.fieldId ? { fieldId: it.fieldId } : {}),
      // ChangeDetails has no nullable fields in the spec, so an empty side is left out.
      ...(it.from !== null ? { from: it.from } : {}),
      ...(it.fromString !== null ? { fromString: it.fromString } : {}),
      ...(it.to !== null ? { to: it.to } : {}),
      ...(it.toString !== null ? { toString: it.toString } : {}),
    })),
  };
}

export function commentJson(c: RenderContext, issue: SiteIssue, cm: SiteIssue["comments"][number]): Json {
  return {
    self: `${c.base}/rest/api/${c.v}/issue/${issue.id}/comment/${cm.id}`,
    id: cm.id,
    author: userJson(c, cm.author),
    body: richTextJson(c, cm.body),
    updateAuthor: userJson(c, cm.author),
    created: cm.created,
    updated: cm.updated,
    ...(cm.visibility ? { visibility: cm.visibility } : {}),
    ...(cloud(c) ? { jsdPublic: true } : {}),
  };
}

export function issueJson(c: RenderContext, issue: SiteIssue, o: IssueRenderOptions): Json {
  if (o.fields.idOnly && o.expand.size === 0 && o.properties.length === 0) return { id: issue.id };
  const { site } = c;
  const project = site.projects.find((p) => p.key === issue.project)!;
  const type = project.issueTypes.find((t) => t.id === issue.issueType)!;
  const status = site.statuses.find((s) => s.id === issue.status)!;
  const brief = (i: SiteIssue) => {
    const p = site.projects.find((p) => p.key === i.project)!;
    return {
      id: i.id, key: i.key, self: `${c.base}/rest/api/${c.v}/issue/${i.id}`,
      fields: {
        summary: i.summary,
        status: statusJson(c, site.statuses.find((s) => s.id === i.status)!),
        priority: priorityJson(i.priority),
        issuetype: issueTypeJson(c, p, p.issueTypes.find((t) => t.id === i.issueType)!),
      },
    };
  };
  const priorityJson = (name: string) => {
    const p = site.priorities.find((p) => p.name === name);
    return p ? { self: `${c.base}/rest/api/${c.v}/priority/${p.id}`, iconUrl: `${c.base}/images/icons/priorities/${p.name.toLowerCase()}.svg`, name: p.name, id: p.id } : null;
  };
  const byKey = (k: string) => site.issues.find((i) => i.key === k);
  const parent = issue.parent ? byKey(issue.parent) : undefined;
  const estimateField = site.boards.find((b) => b.projectKey === project.key && b.estimationFieldId)?.estimationFieldId
    ?? site.fields.find((f) => f.schema?.custom === "com.pyxis.greenhopper.jira:jsw-story-points" && (!f.scopeProjectId || f.scopeProjectId === project.id))?.id
    ?? site.fields.find((f) => f.name === "Story Points")?.id;

  const value = (id: string): unknown => {
    switch (id) {
      case "summary": return issue.summary;
      case "description": return richTextJson(c, issue.description);
      case "status": return statusJson(c, status);
      case "assignee": return userJson(c, issue.assignee);
      case "reporter": return userJson(c, issue.reporter);
      case "priority": return priorityJson(issue.priority);
      case "issuetype": return issueTypeJson(c, project, type);
      case "project": return projectRefJson(c, project);
      case "resolution": {
        const r = site.resolutions.find((r) => r.name === issue.resolution);
        return r ? { self: `${c.base}/rest/api/${c.v}/resolution/${r.id}`, id: r.id, description: "", name: r.name } : null;
      }
      case "labels": return issue.labels;
      case "components": return issue.components.map((name) => ({ self: `${c.base}/rest/api/${c.v}/component/${stableId(name)}`, id: stableId(name), name }));
      case "fixVersions": return issue.fixVersions.map((name) => ({ self: `${c.base}/rest/api/${c.v}/version/${stableId(name)}`, id: stableId(name), name, description: "", archived: false, released: false }));
      case "parent": {
        // DC's parent field is for sub-tasks only; an epic is linked through Epic Link.
        if (!parent || !o.visible(parent) || (!cloud(c) && !type.subtask)) return undefined;
        return brief(parent);
      }
      case "subtasks": return site.issues.filter((i) => i.parent === issue.key && o.visible(i) && site.projects.find((p) => p.key === i.project)?.issueTypes.find((t) => t.id === i.issueType)?.subtask).map(brief);
      case "issuelinks": return issue.links.flatMap((l, n) => {
        const other = byKey(l.key);
        if (!other || !o.visible(other)) return [];
        const t = LINK_TYPES[l.type];
        return [{ id: `${issue.id}${n}`, self: `${c.base}/rest/api/${c.v}/issueLink/${issue.id}${n}`, type: { ...t, self: `${c.base}/rest/api/${c.v}/issueLinkType/${t.id}` }, [l.direction === "inward" ? "inwardIssue" : "outwardIssue"]: brief(other) }];
      });
      case "attachment": return [];
      case "comment": {
        const all = issue.comments;
        const shown = o.embedCaps ? all.slice(0, 20) : all;
        return { comments: shown.map((cm) => commentJson(c, issue, cm)), self: `${c.base}/rest/api/${c.v}/issue/${issue.id}/comment`, maxResults: shown.length, total: all.length, startAt: 0 };
      }
      case "created": return issue.created;
      case "updated": return issue.updated;
    }
    const f = site.fields.find((f) => f.id === id);
    if (!f) return undefined;
    if (f.scopeProjectId && f.scopeProjectId !== project.id) return undefined;
    switch (f.schema?.custom) {
      case "com.pyxis.greenhopper.jira:gh-sprint": {
        const sprints = issue.sprints.map((sid) => site.sprints.find((s) => s.id === sid)!).filter(Boolean);
        if (sprints.length === 0) return null;
        if (!cloud(c)) return sprints.map((s) => `com.atlassian.greenhopper.service.sprint.Sprint@${s.id.toString(16)}[id=${s.id},rapidViewId=${s.boardId},state=${s.state.toUpperCase()},name=${s.name},startDate=${s.startDate ?? "<null>"},endDate=${s.endDate ?? "<null>"},goal=${s.goal ?? ""}]`);
        return sprints.map((s) => ({ id: s.id, name: s.name, state: s.state, boardId: s.boardId, ...(s.goal ? { goal: s.goal } : {}), ...(s.startDate ? { startDate: s.startDate } : {}), ...(s.endDate ? { endDate: s.endDate } : {}) }));
      }
      case "com.pyxis.greenhopper.jira:gh-lexo-rank": return `0|i${String(site.issues.indexOf(issue)).padStart(5, "0")}:`;
      case "com.pyxis.greenhopper.jira:gh-epic-link": {
        const epic = parent && site.projects.find((p) => p.key === parent.project)?.issueTypes.find((t) => t.id === parent.issueType)?.hierarchyLevel === 1;
        return epic ? parent!.key : null;
      }
    }
    if (f.id === estimateField) return issue.estimate ?? null;
    if (f.name === "Flagged") return issue.flagged ? [{ self: `${c.base}/rest/api/${c.v}/customFieldOption/10019`, value: "Impediment", id: "10019" }] : null;
    return issue.custom[f.id] ?? null;
  };

  const out: Json = {
    expand: "renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations",
    id: issue.id,
    self: `${c.base}/rest/api/${c.v}/issue/${issue.id}`,
    key: issue.key,
  };
  const fields: Json = {};
  if (!o.fields.idOnly) for (const id of o.fields.ids) { const v = value(id); if (v !== undefined) fields[id] = v; }
  out.fields = fields;
  if (o.properties.length) out.properties = Object.fromEntries(o.properties.filter((k) => k in issue.properties).map((k) => [k, issue.properties[k]]));
  if (o.expand.has("names")) out.names = Object.fromEntries(fieldsFor(site, project.id).filter((f) => f.id in fields).map((f) => [f.id, f.name]));
  if (o.expand.has("changelog")) {
    const newest = [...issue.changelog].reverse();
    const shown = o.embedCaps ? newest.slice(0, 40) : newest;
    out.changelog = { startAt: 0, maxResults: shown.length, total: issue.changelog.length, histories: shown.map((h) => historyJson(c, h)) };
  }
  if (o.expand.has("transitions") && o.transitions) out.transitions = o.transitions(issue);
  return out;
}

/** A stable numeric id for a named thing the model keeps by name (components, versions). */
function stableId(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return String(10000 + (h % 90000));
}
