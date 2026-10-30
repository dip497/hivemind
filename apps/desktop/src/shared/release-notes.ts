/** What each version changed, as CHANGELOG.md says it: a `## [X.Y.Z] — date` heading per version. */

/** One version's part of the changelog, its lines as Markdown. */
export interface ReleaseNotes {
  version: string;
  date: string;
  body: string;
}

const HEADING = /^## \[(\d+(?:\.\d+)*)\](?:\s+—\s+(\S+))?\s*$/;

/** Whether dotted version `a` comes after `b`. */
export function versionAfter(a: string, b: string): boolean {
  const x = a.split(".").map((n) => parseInt(n, 10) || 0);
  const y = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/** The versions after `after` up to `upTo`, newest first; with no `after`, `upTo`'s own. What is
 *  not released yet (`[Unreleased]`) is never one of them. */
export function releaseNotes(changelog: string, upTo: string, after: string | null): ReleaseNotes[] {
  const out: ReleaseNotes[] = [];
  let at: ReleaseNotes | null = null;
  for (const line of changelog.split("\n")) {
    if (line.startsWith("## ")) {
      at = null;
      const m = HEADING.exec(line);
      if (!m) continue;
      const v = m[1]!;
      const wanted = after === null ? v === upTo : versionAfter(v, after) && !versionAfter(v, upTo);
      if (!wanted) continue;
      at = { version: v, date: m[2] ?? "", body: "" };
      out.push(at);
      continue;
    }
    if (at) at.body += `${line}\n`;
  }
  for (const n of out) n.body = n.body.trim();
  return out.sort((a, b) => (versionAfter(a.version, b.version) ? -1 : 1));
}
