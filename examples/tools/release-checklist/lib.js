// Turning git's answers into pass or fail, with the reason. No imports: the tests load it as it is.

/** `git status --porcelain`: clean, or how many files are changed and which. */
export function workingTree(porcelain) {
  const files = porcelain.split("\n").filter((l) => l.trim()).map((l) => l.slice(3));
  return files.length
    ? { pass: false, detail: `${files.length} file${files.length === 1 ? "" : "s"} not committed: ${files.slice(0, 5).join(", ")}${files.length > 5 ? " …" : ""}` }
    : { pass: true, detail: "Nothing uncommitted" };
}

/** `git rev-list --left-right --count HEAD...@{u}`: commits only here, and only on the remote. */
export function upToDate(stdout) {
  const m = /^(\d+)\s+(\d+)/.exec(stdout.trim());
  if (!m) return { pass: false, detail: "Could not compare with the remote" };
  const ahead = Number(m[1]), behind = Number(m[2]);
  if (!ahead && !behind) return { pass: true, detail: "Same as its remote", ahead, behind };
  const parts = [];
  if (ahead) parts.push(`${ahead} commit${ahead === 1 ? "" : "s"} not pushed`);
  if (behind) parts.push(`${behind} commit${behind === 1 ? "" : "s"} not pulled`);
  return { pass: false, detail: parts.join(", "), ahead, behind };
}

/** The changelog's first `## ` section: what it is called and whether anything is written under it. */
export function changelogTop(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^##\s+\S/.test(l));
  if (start < 0) return { pass: false, detail: "No section in the changelog" };
  const heading = lines[start].replace(/^##\s+/, "").trim();
  let entries = 0;
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) if (/^\s*[-*]\s+\S/.test(lines[i])) entries++;
  const unreleased = /unreleased/i.test(heading);
  if (!entries) return { pass: false, detail: `"${heading}" has no entries`, heading, entries };
  return { pass: true, detail: `${unreleased ? "Unreleased" : heading}: ${entries} entr${entries === 1 ? "y" : "ies"}`, heading, entries };
}

/** Lines a diff adds that hold a TODO or FIXME, with their file and line number. */
export function addedMarkers(diff, markers = ["TODO", "FIXME"]) {
  const word = new RegExp(`\\b(${markers.join("|")})\\b`);
  const found = [];
  let file = null, line = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) { file = l.slice(4).replace(/^b\//, ""); continue; }
    if (l.startsWith("--- ")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (file === null) continue;
    if (l.startsWith("+")) {
      if (word.test(l)) found.push({ file, line, text: l.slice(1).trim().slice(0, 160) });
      line++;
    } else if (!l.startsWith("-") && !l.startsWith("\\")) line++;
  }
  return found;
}

/** A command line as a program and its arguments, keeping "quoted words" together. No shell. */
export function splitCommand(line) {
  const words = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) words.push(m[1] ?? m[2] ?? m[3]);
  return words.length ? { bin: words[0], args: words.slice(1) } : null;
}

/** How many checks passed of those that ran (a skipped one counts for neither). */
export function tally(results) {
  const ran = results.filter((r) => r.state === "pass" || r.state === "fail");
  return { passed: ran.filter((r) => r.state === "pass").length, ran: ran.length, total: results.length };
}
