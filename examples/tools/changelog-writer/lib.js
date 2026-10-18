// Grouping commits by their conventional-commit type and writing the draft. No imports: the tests load it as it is.

/** What `git log` is asked to print: hash, subject and body, split by unit and record separators. */
export const LOG_FORMAT = "%h%x1f%s%x1f%b%x1e";

export function parseLog(out) {
  return out.split("\u001e").filter((r) => r.trim()).map((r) => {
    const [hash, subject = "", body = ""] = r.split("\u001f");
    return { hash: hash.trim(), subject: subject.trim(), body: body.trim() };
  });
}

/** The sections of the draft, in the order they are written, and the types each takes. */
export const SECTIONS = [
  { key: "breaking", title: "Breaking" },
  { key: "added", title: "Added", types: ["feat", "feature"] },
  { key: "fixed", title: "Fixed", types: ["fix", "bugfix"] },
  { key: "performance", title: "Performance", types: ["perf"] },
  { key: "changed", title: "Changed", types: ["refactor", "style", "revert"] },
  { key: "documentation", title: "Documentation", types: ["docs", "doc"] },
  { key: "other", title: "Other", types: ["chore", "build", "ci", "test", "tests"] },
];

/** A commit's type, scope, whether it breaks something, and what it says, from `type(scope)!: text`. */
export function readCommit(c) {
  const m = /^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/.exec(c.subject);
  const breaking = !!m?.[3] || /^BREAKING[ -]CHANGE:/m.test(c.body);
  if (!m) return { ...c, type: null, scope: null, breaking, text: c.subject };
  return { ...c, type: m[1].toLowerCase(), scope: m[2] || null, breaking, text: m[4].trim() };
}

/** Commits grouped into the draft's sections; a release commit is left out. */
export function groupCommits(commits) {
  const groups = Object.fromEntries(SECTIONS.map((s) => [s.key, []]));
  for (const raw of commits) {
    const c = readCommit(raw);
    if (c.type === "chore" && c.scope === "release") continue;
    if (/^Merge (branch|pull request) /.test(c.subject)) continue;
    const section = c.breaking ? "breaking" : SECTIONS.find((s) => s.types?.includes(c.type))?.key ?? "other";
    groups[section].push(c);
  }
  return groups;
}

/** The draft, in Markdown: a heading, then one list per section that has entries. */
export function renderMarkdown(groups, { since = null, title = "Unreleased", hashes = true } = {}) {
  const lines = [`## [${title}]${since ? ` (since ${since})` : ""}`];
  for (const s of SECTIONS) {
    const list = groups[s.key];
    if (!list?.length) continue;
    lines.push("", `### ${s.title}`, "");
    for (const c of list) {
      const text = c.text.charAt(0).toUpperCase() + c.text.slice(1);
      lines.push(`- ${c.scope ? `**${c.scope}:** ` : ""}${text}${hashes ? ` (${c.hash})` : ""}`);
    }
  }
  if (lines.length === 1) lines.push("", "Nothing since then.");
  return lines.join("\n") + "\n";
}
