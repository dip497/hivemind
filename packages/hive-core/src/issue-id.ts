// What an issue id may look like, in one place (design jira-sync §5.2). No imports, so a sandboxed
// view can bundle it as cheaply as core does.
//
// - A local id is the workspace prefix (an uppercase letter, then 1-9 uppercase letters or digits),
//   `-`, a number, and optionally dotted sub-issue numbers: `PAY-42`, `PAY-1.2.3`.
// - An id mirrored from an external tracker is that tracker's key: Jira allows longer project keys
//   and, with an admin setting, underscores (`LONG_PROJECT-7`). Never dotted: a tracker's sub-tasks
//   have keys of their own and are stored as separate issues with `parent:`.
//
// Every id this accepts is also a safe file name: no `/`, `\`, or a leading `.`, so `issuePath`
// keeps it inside `.hivemind/` (its path-traversal guard is this pattern).

const LOCAL = "[A-Z][A-Z0-9]{1,9}-\\d+(?:\\.\\d+)*";
const EXTERNAL = "[A-Z][A-Z0-9_]{1,254}-\\d+";

/** Any issue id hive accepts: a local id (dotted sub-issues allowed) or a tracker's key. */
export const ISSUE_ID_RE = new RegExp(`^(?:${LOCAL}|${EXTERNAL})$`);

/** An id a workspace mints itself: its own prefix's form, dotted sub-issues allowed. */
export const LOCAL_ISSUE_ID_RE = new RegExp(`^${LOCAL}$`);

/** A workspace's own prefix (config.yaml `prefix`). */
export const LOCAL_PREFIX_RE = /^[A-Z][A-Z0-9]{1,9}$/;

/** A prefix mirrored from a tracker (config.yaml `external_prefixes`). */
export const EXTERNAL_PREFIX_RE = /^[A-Z][A-Z0-9_]{1,254}$/;

/** `@PAY-42` mentions in free text; group 1 is the id. A fresh global regex per call (it is stateful). */
export const mentionRe = (): RegExp => new RegExp(`@(${LOCAL}|${EXTERNAL})`, "g");

export const isIssueId = (s: string): boolean => ISSUE_ID_RE.test(s);

/** The prefix of an id (`PAY-1.2` → `PAY`, `LONG_KEY-3` → `LONG_KEY`), or null if it isn't one. */
export function issuePrefix(id: string): string | null {
  const s = id.trim();
  return ISSUE_ID_RE.test(s) ? s.slice(0, s.indexOf("-")) : null;
}
