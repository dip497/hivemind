// The example tool plugins' own logic, on the output the programs they run really print.
import { test, expect } from "bun:test";
// @ts-ignore plain ES modules served to the app as they are
import * as audit from "../../../examples/tools/dependency-audit/lib.js";
// @ts-ignore
import * as flaky from "../../../examples/tools/flaky-tests/lib.js";
// @ts-ignore
import * as changelog from "../../../examples/tools/changelog-writer/lib.js";
// @ts-ignore
import * as release from "../../../examples/tools/release-checklist/lib.js";
// @ts-ignore
import * as bundle from "../../../examples/tools/bundle-size/lib.js";
// @ts-ignore
import * as sqlite from "../../../examples/tools/sqlite-browser/lib.js";
// @ts-ignore
import * as logs from "../../../examples/tools/log-tail/lib.js";
// @ts-ignore
import * as api from "../../../examples/tools/api-explorer/lib.js";

// dependency audit

test("each lockfile's pinned packages are read, and a workspace's own packages are left out", () => {
  const cargo = `version = 4

[[package]]
name = "my-app"
version = "0.1.0"
dependencies = [
 "serde",
]

[[package]]
name = "serde"
version = "1.0.197"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "3fb1c873e1b9b056a4dc4c0c198b24c3ffa059243875552b2bd0933b1aee4ce2"
`;
  expect(audit.parseLockfile("Cargo.lock", cargo)).toEqual([{ name: "serde", version: "1.0.197" }]);

  const npm = JSON.stringify({
    name: "web", lockfileVersion: 3,
    packages: {
      "": { name: "web", version: "1.0.0" },
      "node_modules/lodash": { version: "4.17.15" },
      "node_modules/@babel/core": { version: "7.24.0" },
      "node_modules/a/node_modules/lodash": { version: "4.17.21" },
      "node_modules/shared": { resolved: "packages/shared", link: true },
      "packages/shared": { name: "shared", version: "1.0.0" },
    },
  });
  expect(audit.parseLockfile("web/package-lock.json", npm)).toEqual([
    { name: "lodash", version: "4.17.15" }, { name: "@babel/core", version: "7.24.0" }, { name: "lodash", version: "4.17.21" },
  ]);

  const yarn1 = `# yarn lockfile v1


"@babel/code-frame@^7.0.0", "@babel/code-frame@^7.22.13":
  version "7.23.5"
  resolved "https://registry.yarnpkg.com/@babel/code-frame/-/code-frame-7.23.5.tgz"

lodash@^4.17.15:
  version "4.17.15"
`;
  expect(audit.parseLockfile("yarn.lock", yarn1)).toEqual([{ name: "@babel/code-frame", version: "7.23.5" }, { name: "lodash", version: "4.17.15" }]);

  const yarnBerry = `__metadata:
  version: 8

"lodash@npm:^4.17.21":
  version: 4.17.21
  resolution: "lodash@npm:4.17.21"

"web@workspace:.":
  version: 0.0.0-use.local
`;
  expect(audit.parseLockfile("yarn.lock", yarnBerry)).toEqual([{ name: "lodash", version: "4.17.21" }]);

  const pnpm9 = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      react:
        specifier: ^18.2.0
        version: 18.2.0

packages:
  '@babel/core@7.24.0':
    resolution: {integrity: sha512-x}
  react-dom@18.2.0(react@18.2.0):
    resolution: {integrity: sha512-y}
  react@18.2.0:
    resolution: {integrity: sha512-z}

snapshots:
  react@18.2.0:
    dependencies: {}
`;
  expect(audit.parseLockfile("pnpm-lock.yaml", pnpm9)).toEqual([
    { name: "@babel/core", version: "7.24.0" }, { name: "react-dom", version: "18.2.0" }, { name: "react", version: "18.2.0" },
  ]);
  const pnpm5 = `lockfileVersion: 5.4

packages:
  /@types/node/20.11.5:
    resolution: {integrity: sha512-x}
  /react-dom/18.2.0_react@18.2.0:
    resolution: {integrity: sha512-y}
`;
  expect(audit.parseLockfile("pnpm-lock.yaml", pnpm5)).toEqual([{ name: "@types/node", version: "20.11.5" }, { name: "react-dom", version: "18.2.0" }]);

  const uv = `version = 1
requires-python = ">=3.11"

[[package]]
name = "api"
version = "0.1.0"
source = { editable = "." }

[[package]]
name = "jinja2"
version = "2.10"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "markupsafe" },
]
`;
  expect(audit.parseLockfile("uv.lock", uv)).toEqual([{ name: "jinja2", version: "2.10" }]);

  const poetry = `[[package]]
name = "requests"
version = "2.19.0"
description = "Python HTTP for Humans."
optional = false

[package.dependencies]
idna = ">=2.5"
`;
  expect(audit.parseLockfile("poetry.lock", poetry)).toEqual([{ name: "requests", version: "2.19.0" }]);

  const reqs = `# pinned
Django==3.2.0
requests[security]==2.19.0 ; python_version >= "3.8"
flask>=2.0
-e .
`;
  expect(audit.parseLockfile("requirements.txt", reqs)).toEqual([{ name: "Django", version: "3.2.0" }, { name: "requests", version: "2.19.0" }]);
});

test("lockfiles are found among the repository's files, but not inside node_modules or a virtual environment", () => {
  const ls = "Cargo.lock\ncrates/x/Cargo.toml\nweb/package-lock.json\nnode_modules/foo/package-lock.json\napi/requirements.txt\n.venv/lib/requirements.txt\nREADME.md\n";
  expect(audit.findLockfiles(ls)).toEqual(["Cargo.lock", "web/package-lock.json", "api/requirements.txt"]);
});

test("a batch answer is matched to its packages by position, a package with no advisory getting none", () => {
  const stdout = JSON.stringify({
    results: [
      { vulns: [{ id: "GHSA-29mw-wpgm-hmr9", modified: "2025-09-29T21:12:31Z" }, { id: "GHSA-35jh-r3h4-6jhm", modified: "2026-01-01T00:00:00Z" }] },
      {},
      { vulns: [{ id: "GHSA-462w-v97r-4m45", modified: "2024-09-24T21:03:59Z" }] },
    ],
  });
  expect(audit.readBatch(stdout, 3)).toEqual([["GHSA-29mw-wpgm-hmr9", "GHSA-35jh-r3h4-6jhm"], [], ["GHSA-462w-v97r-4m45"]]);
  expect(audit.batches(Array.from({ length: 2500 }, (_, i) => i)).map((b: unknown[]) => b.length)).toEqual([1000, 1000, 500]);
});

test("a CVSS 3 vector scores as the specification's calculator does", () => {
  expect(audit.cvss3Score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L")).toBe(5.3);
  expect(audit.cvss3Score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBe(9.8);
  expect(audit.cvss3Score("CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:C/C:L/I:L/A:N")).toBe(5.4);
  expect(audit.cvss3Score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H")).toBe(10);
  expect(audit.cvss3Score("CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:C/C:H/I:H/A:H")).toBe(9.1);
});

test("an advisory's severity is the database's word, else its CVSS score's band", () => {
  const ghsa = { id: "GHSA-29mw-wpgm-hmr9", database_specific: { severity: "MODERATE" }, severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }] };
  expect(audit.severityOf(ghsa)).toBe("moderate");
  const pysec = { id: "PYSEC-2019-217", severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }] };
  expect(audit.severityOf(pysec)).toBe("critical");
  expect(audit.severityOf({ id: "RUSTSEC-2024-0001" })).toBe("unknown");
});

test("the fix offered is the lowest fixed version above the installed one, for that package only", () => {
  const vuln = {
    id: "GHSA-x",
    affected: [
      { package: { name: "lodash-es", ecosystem: "npm" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.16" }] }] },
      { package: { name: "lodash", ecosystem: "npm" }, ranges: [
        { type: "SEMVER", events: [{ introduced: "3.0.0" }, { fixed: "3.10.2" }, { introduced: "4.0.0" }, { fixed: "4.17.21" }] },
        { type: "SEMVER", events: [{ introduced: "4.17.0" }, { fixed: "4.17.19" }] },
      ] },
    ],
  };
  expect(audit.fixedVersion(vuln, { name: "lodash", version: "4.17.15" })).toBe("4.17.19");
  expect(audit.fixedVersion(vuln, { name: "lodash", version: "4.17.20" })).toBe("4.17.21");
  expect(audit.fixedVersion(vuln, { name: "lodash", version: "4.17.21" })).toBe(null);
});

test("one problem published under several ids is one finding, with the severity one of them knows", () => {
  const django = { name: "Django", version: "3.2.0", ecosystem: "PyPI" };
  const pysec = audit.finding(django, { id: "PYSEC-2022-190", aliases: ["CVE-2022-28346", "GHSA-2gwj-7jmv-h26r"], summary: "SQL injection" });
  const ghsa = audit.finding(django, { id: "GHSA-2gwj-7jmv-h26r", aliases: ["CVE-2022-28346"], summary: "SQL Injection in Django", database_specific: { severity: "CRITICAL" } });
  const other = audit.finding(django, { id: "GHSA-2hrw-hx67-34x6", aliases: ["CVE-2023-24580"], summary: "Resource exhaustion", database_specific: { severity: "HIGH" } });
  const sameIdElsewhere = audit.finding({ name: "django-cms", version: "3.2.0", ecosystem: "PyPI" }, { id: "GHSA-2gwj-7jmv-h26r", aliases: [] });
  const kept = audit.dedupeFindings([pysec, ghsa, other, sameIdElsewhere]);
  expect(kept.map((f: { package: string; id: string; severity: string }) => [f.package, f.id, f.severity])).toEqual([
    ["Django", "GHSA-2gwj-7jmv-h26r", "critical"], ["Django", "GHSA-2hrw-hx67-34x6", "high"], ["django-cms", "GHSA-2gwj-7jmv-h26r", "unknown"],
  ]);
});

test("findings are listed worst first", () => {
  const f = (pkg: string, severity: string) => ({ package: pkg, id: `${pkg}-${severity}`, severity });
  expect(audit.sortFindings([f("b", "low"), f("a", "moderate"), f("c", "critical"), f("d", "unknown"), f("a", "high")]).map((x: { id: string }) => x.id))
    .toEqual(["c-critical", "a-high", "a-moderate", "b-low", "d-unknown"]);
});

// flaky tests

test("a test command line is split into its program and arguments, quoted words kept whole", () => {
  expect(flaky.splitCommand(`pytest -v -k "slow and not db" tests/`)).toEqual({ bin: "pytest", args: ["-v", "-k", "slow and not db", "tests/"] });
  expect(flaky.splitCommand("   ")).toBe(null);
});

test("each reporter's per-test lines are read as passed or failed, skipped tests and summaries left out", () => {
  const bun = `bun test v1.3.11 (af24e281)

a.test.js:
(pass) cart > adds an item [0.12ms]
(pass) cart > sometimes [0.03ms]
error: expect(received).toBe(expected)

Expected: 2
Received: 1

(fail) fails [0.40ms]
(skip) skipped

 2 pass
 1 skip
 1 fail
`;
  expect([...flaky.parseRun(bun)]).toEqual([["cart > adds an item", true], ["cart > sometimes", true], ["fails", false]]);

  // With colour on (as when the app runs it), bun marks a test with ✓ and ✗ instead.
  const bunColoured = "\u001b[0m\u001b[32m✓\u001b[0m \u001b[0mcart\u001b[2m >\u001b[0m\u001b[1m adds an item\u001b[0m\n"
    + "\u001b[0m\u001b[31m✗\u001b[0m \u001b[0mcart\u001b[2m >\u001b[0m\u001b[1m totals in cents\u001b[0m\n"
    + "\u001b[0m\u001b[32m✓\u001b[0m\u001b[0m\u001b[1m formats prices\u001b[0m \u001b[0m\u001b[2m[1.00ms\u001b[0m\u001b[2m]\u001b[0m\n\u001b[0m\u001b[32m 2 pass\u001b[0m\n";
  expect([...flaky.parseRun(bunColoured)]).toEqual([["cart > adds an item", true], ["cart > totals in cents", false], ["formats prices", true]]);

  const tap = `TAP version 13
# Subtest: top ok
ok 1 - top ok
  ---
  duration_ms: 0.81
  ...
# Subtest: top bad
not ok 2 - top bad
  ---
  error: '1 == 2'
  ...
# Subtest: group
    # Subtest: inner ok
    ok 1 - inner ok
    1..1
ok 3 - group
ok 4 - skip me # SKIP
1..4
`;
  expect([...flaky.parseRun(tap)]).toEqual([["top ok", true], ["top bad", false], ["inner ok", true], ["group", true]]);

  const pytest = `============================= test session starts ==============================
collected 3 items

tests/test_cart.py::test_add PASSED                                      [ 33%]
tests/test_cart.py::test_total[eur] FAILED                               [ 66%]
tests/test_cart.py::test_skip SKIPPED (no db)                            [100%]

=========================== short test summary info ============================
FAILED tests/test_cart.py::test_total[eur] - AssertionError: assert 9 == 10
========================= 1 failed, 1 passed, 1 skipped in 0.12s =========================
`;
  expect([...flaky.parseRun(pytest)]).toEqual([["tests/test_cart.py::test_add", true], ["tests/test_cart.py::test_total[eur]", false]]);

  const jest = `FAIL src/basket.test.js
  basket
    ✕ adds an item (4 ms)
FAIL src/cart.test.js
  cart
    ✓ adds an item (3 ms)
    ✕ applies a coupon (12 ms)
`;
  // Two tests of one name read as one, failed if either failed.
  expect([...flaky.parseRun(jest)]).toEqual([["adds an item", false], ["applies a coupon", false]]);

  const vitest = ` ✓ src/cart.test.ts (2 tests) 5ms
 ✓ src/cart.test.ts > cart > adds an item 1ms
 × src/cart.test.ts > cart > applies a coupon 4ms
`;
  expect([...flaky.parseRun(vitest)]).toEqual([["src/cart.test.ts > cart > adds an item", true], ["src/cart.test.ts > cart > applies a coupon", false]]);

  const coloured = "\u001b[32m✔\u001b[39m top ok \u001b[90m(0.8ms)\u001b[39m\n\u001b[31m✖ top bad \u001b[90m(0.9ms)\u001b[39m\u001b[39m\n";
  expect([...flaky.parseRun(coloured)]).toEqual([["top ok", true], ["top bad", false]]);
});

test("a test that passed in some runs and failed in others is flaky, and listed before the rest", () => {
  const runs = [
    new Map([["steady", true], ["races", true], ["broken", false]]),
    new Map([["steady", true], ["races", false], ["broken", false]]),
    new Map([["steady", true], ["races", true], ["broken", false]]),
  ];
  const summary = flaky.summarize(runs);
  expect(summary.map((t: { name: string; flaky: boolean; passed: number; failed: number }) => [t.name, t.flaky, t.passed, t.failed]))
    .toEqual([["races", true, 2, 1], ["broken", false, 0, 3], ["steady", false, 3, 0]]);
  expect(summary[0].history).toEqual([true, false, true]);
});

// changelog writer

test("commits are grouped by type, a breaking change on its own, and a release commit left out", () => {
  const log = [
    "a1b2c3d\u001ffeat(editor): open files from the search box\u001f\u001e",
    "\nb2c3d4e\u001ffix: the tab bar no longer jumps\u001fFixes #12\u001e",
    "\nc3d4e5f\u001ffeat(api)!: rename the hello message\u001f\u001e",
    "\nd4e5f6a\u001frefactor(core): one owner for settings\u001fBREAKING CHANGE: settings.json moves\u001e",
    "\ne5f6a7b\u001fchore(release): v2026.9.0\u001f\u001e",
    "\nf6a7b8c\u001fUpdate the README\u001f\u001e",
    "\n0a1b2c3\u001fperf: draw only shown terminals\u001f\u001e",
  ].join("");
  const commits = changelog.parseLog(log);
  expect(commits[1]).toEqual({ hash: "b2c3d4e", subject: "fix: the tab bar no longer jumps", body: "Fixes #12" });
  const g = changelog.groupCommits(commits);
  const hashes = (k: string) => g[k].map((c: { hash: string }) => c.hash);
  expect([hashes("breaking"), hashes("added"), hashes("fixed"), hashes("performance"), hashes("changed"), hashes("other")])
    .toEqual([["c3d4e5f", "d4e5f6a"], ["a1b2c3d"], ["b2c3d4e"], ["0a1b2c3"], [], ["f6a7b8c"]]);
});

test("the draft has a section per group with entries, scope in bold", () => {
  const g = changelog.groupCommits([
    { hash: "a1b2c3d", subject: "feat(editor): open files from the search box", body: "" },
    { hash: "b2c3d4e", subject: "fix: the tab bar no longer jumps", body: "" },
  ]);
  expect(changelog.renderMarkdown(g, { since: "v1.4.0" })).toBe(`## [Unreleased] (since v1.4.0)

### Added

- **editor:** Open files from the search box (a1b2c3d)

### Fixed

- The tab bar no longer jumps (b2c3d4e)
`);
});

// release checklist

test("the working tree check names what is not committed", () => {
  expect(release.workingTree("")).toMatchObject({ pass: true });
  expect(release.workingTree(" M src/app.ts\n?? notes.md\n")).toEqual({ pass: false, detail: "2 files not committed: src/app.ts, notes.md" });
});

test("ahead and behind the remote are told apart", () => {
  expect(release.upToDate("0\t0\n")).toMatchObject({ pass: true });
  expect(release.upToDate("2\t0\n")).toMatchObject({ pass: false, detail: "2 commits not pushed" });
  expect(release.upToDate("0\t1\n")).toMatchObject({ pass: false, detail: "1 commit not pulled" });
});

test("a changelog passes only when its top section has entries", () => {
  expect(release.changelogTop("# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Sleep agents\n- Phone view\n\n## [1.0.0]\n\n- First\n"))
    .toMatchObject({ pass: true, heading: "[Unreleased]", entries: 2 });
  expect(release.changelogTop("# Changelog\n\n## [Unreleased]\n\n## [1.0.0]\n\n- First\n")).toMatchObject({ pass: false, entries: 0 });
  expect(release.changelogTop("# Changelog\n")).toMatchObject({ pass: false });
});

test("TODOs a diff adds are found with their file and new line number; removed ones are not", () => {
  const diff = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,4 +10,5 @@ export function start() {
   const a = 1;
-  // TODO: old note
+  // TODO: handle the empty list
   const b = 2;
+  return a + b; // FIXME overflow
 }
diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-// FIXME gone
`;
  expect(release.addedMarkers(diff)).toEqual([
    { file: "src/app.ts", line: 11, text: "// TODO: handle the empty list" },
    { file: "src/app.ts", line: 13, text: "return a + b; // FIXME overflow" },
  ]);
});

// bundle size

test("wc's sizes are read by path inside the folder, its total line left out", () => {
  const out = "  145230 dist/assets/index-4f2a.js\n    8123 dist/assets/index-9c1e.css\n     512 dist/index.html\n  153865 total\n";
  expect(bundle.parseWc(out, "dist")).toEqual([
    { file: "assets/index-4f2a.js", bytes: 145230 }, { file: "assets/index-9c1e.css", bytes: 8123 }, { file: "index.html", bytes: 512 },
  ]);
});

test("the gzip size printed by the script is the size gzip -9 output has", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-size-"));
  const file = path.join(dir, "app.js");
  fs.writeFileSync(file, "export const greet = (name) => `hello ${name}`;\n".repeat(400));
  try {
    const out = execFileSync("python3", ["-c", bundle.GZIP_SCRIPT, file], { encoding: "utf8" });
    // gzip -n leaves out the file name and time, as a web server's gzip does.
    const reference = execFileSync("gzip", ["-9", "-n", "-c", file]).length;
    expect(bundle.parseGzip(out, dir)).toEqual({ "app.js": reference });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("each file's change since the baseline, with files added and removed", () => {
  const baseline = bundle.snapshot([{ file: "app.js", bytes: 1000, gzip: 400 }, { file: "old.css", bytes: 300 }], "2026-10-01T00:00:00.000Z");
  const c = bundle.compare([{ file: "app.js", bytes: 1200, gzip: 450 }, { file: "chunk.js", bytes: 50 }], baseline);
  expect(c.rows).toEqual([
    { file: "app.js", bytes: 1200, gzip: 450, was: 1000, change: 200, added: false },
    { file: "chunk.js", bytes: 50, gzip: null, was: null, change: null, added: true },
  ]);
  expect(c.removed).toEqual([{ file: "old.css", was: 300 }]);
  expect([c.total, c.totalWas, c.change]).toEqual([1250, 1300, -50]);
});

test("sizes read as people write them", () => {
  expect([bundle.formatBytes(812), bundle.formatBytes(1010), bundle.formatBytes(14_234), bundle.formatBytes(3_104_000), bundle.formatBytes(-2048)])
    .toEqual(["812 B", "1.01 kB", "14.2 kB", "3.10 MB", "-2.05 kB"]);
});

// sqlite browser

test("sqlite3's own dot commands, which can run programs, are refused before reaching it", () => {
  expect(sqlite.refuseQuery(".shell rm -rf ~")).toMatch(/dot commands/);
  expect(sqlite.refuseQuery("  .system ls")).toMatch(/dot commands/);
  expect(sqlite.refuseQuery("")).toBe("Write a query first.");
  expect(sqlite.refuseQuery("SELECT * FROM users")).toBe(null);
});

test("the queries it builds run on a real database, a table with quotes in its name included", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-browser-"));
  const db = path.join(dir, "app.db");
  try {
    execFileSync("sqlite3", [db, `CREATE TABLE users(id INTEGER, name TEXT); INSERT INTO users VALUES (1,'Ada'),(2,'Linus'); CREATE TABLE "it's ""odd"""(x); CREATE VIEW names AS SELECT name FROM users;`]);
    const run = (sql: string) => sqlite.parseRows(execFileSync("sqlite3", ["-readonly", "-json", db, sql], { encoding: "utf8" }));
    const tables = run(sqlite.TABLES_SQL);
    expect(tables.map((t: { name: string }) => t.name)).toEqual(["it's \"odd\"", "names", "users"]);
    expect(run(sqlite.countSql(tables.map((t: { name: string }) => t.name)))).toEqual([
      { name: "it's \"odd\"", count: 0 }, { name: "names", count: 2 }, { name: "users", count: 2 },
    ]);
    expect(run(sqlite.rowsSql("users", 1))).toEqual([{ id: 1, name: "Ada" }]);
    expect(run(sqlite.rowsSql("it's \"odd\""))).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("database files are found once each, outside node_modules", () => {
  expect(sqlite.databaseFiles("data/app.db\nREADME.md\nnode_modules/x/test.sqlite\n", "./data/app.db\n./cache.sqlite3\n./notes.txt\n"))
    .toEqual(["cache.sqlite3", "data/app.db"]);
});

// log tail

test("a line's level is read from its level word or a JSON logger's field", () => {
  expect(logs.levelOf("2026-10-18 12:00:01 ERROR payment failed: card declined")).toBe("error");
  expect(logs.levelOf("[2026-10-18T12:00:02Z] WARN  slow query took 812ms")).toBe("warn");
  expect(logs.levelOf("12:00:03 INFO  retrying after error from upstream")).toBe("info");
  expect(logs.levelOf('time=2026-10-18T12:00:04Z level=debug msg="cache hit"')).toBe("debug");
  expect(logs.levelOf('{"level":50,"time":1760788800000,"msg":"db down"}')).toBe("error");
  expect(logs.levelOf('{"level":"warning","message":"disk 91% full"}')).toBe("warn");
  expect(logs.levelOf("GET /health 200 3ms")).toBe(null);
});

test("a stack trace's lines take the level of the error above them", () => {
  const lines = logs.readLines("12:00 ERROR request failed\nTypeError: x is undefined\n    at handler (src/api.js:12:5)\n12:01 INFO back to normal\n");
  expect(lines.map((l: { level: string | null }) => l.level)).toEqual(["error", "error", "error", "info"]);
  expect(logs.countLevels(lines)).toEqual({ error: 3, warn: 0, info: 1, debug: 0 });
});

test("a filter is text ignoring case, or a /regular expression/; a broken one says why and hides nothing", () => {
  expect(logs.makeFilter("Card").test("payment failed: card declined")).toBe(true);
  expect(logs.makeFilter("/took \\d{3,}ms/").test("slow query took 812ms")).toBe(true);
  expect(logs.makeFilter("/took \\d{3,}ms/").test("query took 12ms")).toBe(false);
  const broken = logs.makeFilter("/(unclosed/");
  expect(broken.error).toBeTruthy();
  expect(broken.test("anything")).toBe(true);
});

test("a JSON log line is shown as its time, message and other fields", () => {
  expect(logs.messageOf('{"level":30,"time":"2026-10-18T12:00:00Z","pid":1,"msg":"listening","port":8000}')).toBe("2026-10-18T12:00:00Z listening  port=8000");
});

// api explorer

test("routes are read from each framework's way of declaring them, and client calls are not routes", () => {
  const grep = [
    'api/main.py:14:@app.get("/items/{item_id}")',
    "api/users.py:8:@router.post('/users', status_code=201)",
    'api/auth.py:3:@app.route("/login", methods=["GET", "POST"])',
    "web/server.js:21:app.get('/health', (req, res) => res.send('ok'));",
    "web/server.js:22:router.delete(`/users/:id`, remove);",
    "web/client.js:5:const r = await axios.get('/api/users');",
    'svc/main.go:30:\tmux.HandleFunc("GET /orders/{id}", getOrder)',
    'svc/main.go:31:\tr.POST("/orders", create)',
    'rs/src/main.rs:40:        .route("/todos", get(list_todos).post(create_todo))',
    "web/server.test.js:4:app.get('/only-in-a-test', h);",
    "web/server.js:2:// app.get('/commented-out', h)",
    // Docs quote routes in their examples; only code declares them.
    'docs/en/docs/index.md:210:@app.get("/in-the-docs")',
    'README.md:162:@app.get("/in-the-readme")',
  ].join("\n");
  const found = api.endpointsIn(grep).map((e: { method: string; path: string; file: string; line: number }) => `${e.method} ${e.path} ${e.file}:${e.line}`);
  expect(found).toEqual([
    "GET /health web/server.js:21",
    "GET /items/{item_id} api/main.py:14",
    "GET /login api/auth.py:3",
    "POST /login api/auth.py:3",
    "POST /orders svc/main.go:31",
    "GET /orders/{id} svc/main.go:30",
    "GET /todos rs/src/main.rs:40",
    "POST /todos rs/src/main.rs:40",
    "POST /users api/users.py:8",
    "DELETE /users/:id web/server.js:22",
  ]);
});

test("the search pattern finds the route lines in a real repository", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "api-explorer-"));
  try {
    fs.writeFileSync(path.join(dir, "app.py"), '@app.get("/items/{item_id}")\ndef read(item_id): ...\n');
    fs.writeFileSync(path.join(dir, "server.js"), "app.post('/orders', create);\nconst x = map.get(key);\n");
    fs.writeFileSync(path.join(dir, "main.rs"), '    .route("/todos", get(list))\n');
    fs.writeFileSync(path.join(dir, "main.go"), '\thttp.HandleFunc("/ping", ping)\n');
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    const out = execFileSync("git", ["grep", "-n", "-I", "-E", api.GREP_PATTERN], { cwd: dir, encoding: "utf8" });
    expect(api.endpointsIn(out).map((e: { method: string; path: string }) => `${e.method} ${e.path}`))
      .toEqual(["GET /items/{item_id}", "POST /orders", "ANY /ping", "GET /todos"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a response's status, headers and body are read, an interim 100 Continue skipped", () => {
  const raw = "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\ncontent-type: application/json\r\nx-request-id: 7f3a\r\n\r\n{\"id\":42,\"ok\":true}";
  const r = api.parseResponse(raw);
  expect([r.status, r.statusText, r.headers, r.body]).toEqual([201, "Created", [["content-type", "application/json"], ["x-request-id", "7f3a"]], '{"id":42,"ok":true}']);
  expect(api.prettyBody(r.body)).toBe('{\n  "id": 42,\n  "ok": true\n}');
  expect(api.parseResponse("HTTP/2 204 \r\ndate: Sat, 18 Oct 2026 12:00:00 GMT\r\n\r\n")).toMatchObject({ status: 204, body: "" });
  expect(api.joinUrl("http://127.0.0.1:8000/", "/items/1")).toBe("http://127.0.0.1:8000/items/1");
});
