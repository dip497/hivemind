/**
 * For the migration tests: a temp data root copied from a fixture, the runner run on it in a
 * process of its own (as the app and `hive` run it), and the same run killed at 20 points.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RUN = `const { runMigrations } = await import(${JSON.stringify(path.join(import.meta.dirname, "..", "runner.ts"))});
console.log("started");
const r = await runMigrations({ by: "cli", app: "2026.10.4", say: (line) => console.error(line) });
console.log(JSON.stringify(r));`;

export const ALL = ["0001-adopt-plugins-as-packages", "0002-plugin-state-from-old-keys", "0003-remove-old-one-off-backups", "0004-remove-machines-marker", "0005-ui-font-default"];

export interface Applied { id: string; result: Record<string, unknown> & { adopted?: number; skipped?: { path: string; why: string }[] } }

/** A data root (config and app data in one folder, as on Linux) made from `fixture`. */
export class TestRoot {
  home = "";
  constructor(readonly fixture: string) { this.fresh(); }
  get root(): string { return path.join(this.home, "hivemind"); }
  env(): NodeJS.ProcessEnv { return { ...process.env, XDG_CONFIG_HOME: this.home, HIVEMIND_APP_DATA: this.root, HIVE_SETTINGS: "" }; }
  fresh(): void {
    this.remove();
    this.home = fs.mkdtempSync(path.join(os.tmpdir(), "hive-migration-"));
    fs.cpSync(this.fixture, this.root, { recursive: true });
  }
  remove(): void { if (this.home) fs.rmSync(this.home, { recursive: true, force: true }); }
  read(rel: string): any { return JSON.parse(fs.readFileSync(path.join(this.root, rel), "utf8")); }
  has(rel: string): boolean { return fs.existsSync(path.join(this.root, rel)); }
  ledger(): Applied[] { return this.read("migrations/ledger.json").applied; }
  backup(id: string): Record<string, string> { return files(path.join(this.root, "migrations", "backups", id)); }

  /** One run to the end; what it applied. */
  runOnce(): Applied[] {
    const r = spawnSync("bun", ["-e", RUN], { env: this.env(), encoding: "utf8", timeout: 60_000 });
    if (r.status !== 0) throw new Error(r.stderr);
    return (JSON.parse(r.stdout.trim().split("\n").pop()!) as { applied: Applied[] }[]).flatMap((x) => x.applied);
  }

  /** A run in the background; `onLine` hears what it says. */
  start(onLine?: (line: string) => void): { done: Promise<number | null>; kill: () => void; started: Promise<void>; finished: Promise<void> } {
    const c = spawn("bun", ["-e", RUN], { env: this.env() });
    let started!: () => void;
    const startedP = new Promise<void>((r) => { started = r; });
    let finished!: () => void;
    const finishedP = new Promise<void>((r) => { finished = r; });
    c.stdout!.on("data", (d: Buffer) => {
      if (d.toString().includes("started")) started();
      if (d.toString().includes("[")) finished();
    });
    c.stderr!.on("data", (d: Buffer) => onLine?.(d.toString()));
    return { done: new Promise((r) => c.on("close", r)), kill: () => c.kill("SIGKILL"), started: startedP, finished: finishedP };
  }

  /** Kill runs at 20 points spread over how long one takes, until 20 were cut off before they
   *  finished (a kill that came too late shrinks the spread), running again after each; give each
   *  end state and how many were cut off. */
  async killedAndRunAgain<T>(endState: () => T): Promise<{ clean: T; ends: T[]; cutOff: number }> {
    let took = Infinity;
    for (let n = 0; n < 3; n++) {
      this.fresh();
      const run = this.start();
      await run.started;
      const t = Date.now();
      await run.finished;
      took = Math.min(took, Date.now() - t);
      await run.done;
    }
    const clean = endState();
    const ends: T[] = [];
    let cutOff = 0;
    let spread = took;
    for (let tries = 0; cutOff < 20 && tries < 60; tries++) {
      this.fresh();
      const run = this.start();
      await run.started;
      await new Promise((r) => setTimeout(r, (spread * cutOff) / 20));
      run.kill();
      await run.done;
      if (!this.has("migrations/ledger.json") || this.ledger().length < ALL.length) cutOff++;
      else spread *= 0.8;
      this.runOnce();
      ends.push(endState());
    }
    return { clean, ends, cutOff };
  }
}

/** Every file under `dir` by its path, as a SHA-256. */
export function files(dir: string): Record<string, string> {
  if (!fs.existsSync(dir)) return {};
  const out: Record<string, string> = {};
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const at = path.join(e.parentPath, e.name);
    out[path.relative(dir, at)] = createHash("sha256").update(fs.readFileSync(at)).digest("hex");
  }
  return out;
}
