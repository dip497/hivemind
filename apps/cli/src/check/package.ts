/** `hive plugins check <package folder>`: its `hivemind-package.json` checked as an install checks
 *  it, then every member with its own kind's check (`./check.ts`) and read as an install reads it.
 *  Each problem is placed in the package: a member's at its file and line inside the member's
 *  folder, one of the manifest's at the line that names the member. */
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { checkPackageManifest, entriesOf, ownedBy, PACKAGE_MANIFEST, packageFiles, sizeProblem } from "@hivemind/hub";
import { MEMBER_KINDS } from "@hivemind/core/package-kinds";
import { kindNamed } from "../plugin-kinds.js";
import { sourceOf } from "../package-authoring.js";
import { checkPlugin } from "./check.js";
import type { Problem } from "./problem.js";

/** A problem of a package, with the member it is in (its path in the package), if any. */
export interface PackageProblem extends Problem { member?: string }

export interface PackageCheckReport {
  kind: "package";
  dir: string;
  id: string | null;
  /** What each part came to: `manifest`, then each member by its path (a preset by its id). */
  steps: Record<string, string>;
  members: Array<{ kind: string; path: string; id: string | null; steps: Record<string, string> | null }>;
  notes: string[];
  problems: PackageProblem[];
}

/** The line of `text` that first holds `needle`, counted from 1. */
const lineOf = (text: string, needle: string): number | undefined => {
  const i = text.split("\n").findIndex((l) => l.includes(needle));
  return i < 0 ? undefined : i + 1;
};

export async function checkPackage(dir: string): Promise<PackageCheckReport> {
  const report: PackageCheckReport = { kind: "package", dir, id: null, steps: {}, members: [], notes: [], problems: [] };
  const text = await readFile(path.join(dir, PACKAGE_MANIFEST), "utf8");
  const atManifest = (message: string, needle?: string, member?: string): PackageProblem =>
    ({ step: "manifest", file: PACKAGE_MANIFEST, ...(needle && lineOf(text, needle) ? { line: lineOf(text, needle) } : {}), message, ...(member ? { member } : {}) });
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) {
    report.problems.push(atManifest(`is not JSON: ${e instanceof Error ? e.message : String(e)}`));
    report.steps.manifest = "failed";
    return report;
  }
  const shape = checkPackageManifest(raw);
  if ("problem" in shape) {
    report.problems.push(atManifest(shape.problem));
    report.steps.manifest = "failed";
    return report;
  }
  const m = shape.manifest;
  report.id = m.id;
  const owner = m.id.slice(0, m.id.indexOf("/"));
  const seen = new Map<string, string>();
  for (const k of MEMBER_KINDS) {
    for (const entry of entriesOf(m, k)) {
      const at = (entry as { path?: string }).path;
      const name = at ?? (entry as { id: string }).id;
      const needle = at ? `"${at}"` : `"${name}"`;
      const problems: PackageProblem[] = [];
      let steps: Record<string, string> | null = null;
      const authored = kindNamed(k.kind);
      if (at && authored) {
        const source = sourceOf(authored, path.join(dir, at));
        const rel = path.relative(dir, source).split(path.sep).join("/");
        if (!fs.existsSync(source)) problems.push(atManifest(`${k.list}: there is no folder ${at}`, needle, at));
        else if (!fs.existsSync(path.join(source, authored.manifest))) problems.push(atManifest(`${k.list}: ${at} holds no ${authored.manifest}`, needle, at));
        else {
          const own = await checkPlugin(authored, source);
          steps = own.steps;
          for (const n of own.notes) if (!report.notes.includes(n)) report.notes.push(n);
          problems.push(...own.problems.map((p) => ({ ...p, file: p.file ? `${rel}/${p.file}` : rel, member: at })));
        }
      }
      // Read as an install reads it, once its own check is clean: its id, and whose it is.
      let id: string | null = null;
      if (!problems.length) {
        try { id = (await k.check(dir, entry, { folder: path.basename(dir), package: m.id })).id; } catch (e) {
          problems.push(atManifest(e instanceof Error ? e.message : String(e), needle, name));
        }
      }
      if (id && !ownedBy(m.id, id)) problems.push(atManifest(`${k.noun} ${id} is not ${owner}'s: every member of ${m.id} is ${owner}/<name>`, needle, name));
      if (id && seen.has(`${k.kind}:${id}`)) problems.push(atManifest(`${k.noun} ${id} is named twice: by ${seen.get(`${k.kind}:${id}`)} and ${name}`, needle, name));
      if (id) seen.set(`${k.kind}:${id}`, name);
      report.members.push({ kind: k.kind, path: name, id, steps });
      report.steps[`${k.kind} ${name}`] = problems.length ? "failed" : "ok";
      report.problems.push(...problems);
    }
  }
  // Sized as HiveHub sizes it: what installs (the manifest, a README or licence, the members'
  // folders), without what a build or a checkout leaves beside it.
  const big = sizeProblem(packageFiles(m, filesOf(dir)));
  if (big) report.problems.push({ step: "hub", message: `HiveHub would refuse it: ${big}` });
  report.steps = { manifest: report.problems.some((p) => !p.member && p.step === "manifest") ? "failed" : "ok", ...report.steps, hub: big ? "failed" : "ok" };
  return report;
}

/** Every file under `dir` by its path inside it, with its size; links, node_modules and .git left out. */
function filesOf(dir: string): { path: string; bytes: number }[] {
  const out: { path: string; bytes: number }[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const at = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(at);
      else if (e.isFile()) out.push({ path: at, bytes: fs.statSync(path.join(dir, at)).size });
    }
  };
  walk("");
  return out;
}
