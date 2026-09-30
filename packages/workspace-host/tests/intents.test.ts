// Intents and the audit log they write, against a real directory: what a line records, when an
// intent is said to have been asked, what a failure records, and how the file is kept.
import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Intents, Refused } from "../src/intents.ts";
import { AuditLog } from "../src/audit-log.ts";

let tmp: string;
let file: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "intents-"));
  file = path.join(tmp, "audit.jsonl");
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const lines = (f = file) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const agent = { kind: "tile" as const, tile: "tile-claude-1" };
const MB5 = 5 * 1024 * 1024;

test("an intent that is carried out is recorded with who asked, what, of what, and ok; its result comes back", async () => {
  const intents = new Intents(new AuditLog({ file }));
  const r = await intents.perform(agent, { verb: "agent.approve", target: "tile-codex-2", detail: "allow" }, () => ({ ok: true }));
  expect(r).toEqual({ ok: true });
  // An intent that opens a tile is recorded against the tile it opened.
  await intents.perform({ kind: "person" }, { verb: "tile.spawn_agent", target: (res: { tileId: string }) => res.tileId }, async () => ({ tileId: "tile-codex-3" }));

  const [approve, spawn] = lines();
  expect(approve).toEqual({ at: expect.any(String), actor: agent, verb: "agent.approve", target: "tile-codex-2", detail: "allow", outcome: "ok" });
  expect(Number.isNaN(Date.parse(approve.at))).toBe(false);
  expect(spawn).toEqual({ at: expect.any(String), actor: { kind: "person" }, verb: "tile.spawn_agent", target: "tile-codex-3", outcome: "ok" });
});

test("an intent that fails is recorded with its error's code, and the error reaches the caller", async () => {
  const intents = new Intents(new AuditLog({ file }));
  const refused = Object.assign(new Error("spawn rate limit exceeded"), { code: "RATE_LIMITED" });
  const spawn = intents.perform(agent, { verb: "tile.spawn_agent", target: (res: { tileId: string }) => res.tileId }, async (): Promise<{ tileId: string }> => { throw refused; });
  await expect(spawn).rejects.toBe(refused);
  await expect(intents.perform(agent, { verb: "tile.close", target: "tile-gone" }, () => { throw new Error("no code"); })).rejects.toThrow("no code");

  expect(lines()).toEqual([
    // Nothing was opened, so there is no tile to name.
    { at: expect.any(String), actor: agent, verb: "tile.spawn_agent", outcome: "error", code: "RATE_LIMITED" },
    { at: expect.any(String), actor: agent, verb: "tile.close", target: "tile-gone", outcome: "error" },
  ]);
});

test("an intent only one tile may ask for is refused to any other tile, which is recorded, and it never runs; that tile and a person may", async () => {
  const intents = new Intents(new AuditLog({ file }));
  const worker = { kind: "tile" as const, tile: "tile-worker" };
  let ran = 0;
  const answer = { verb: "agent.approve", target: "tile-worker", detail: "allow", onlyBy: "tile-lead" };
  await expect(intents.perform(worker, answer, () => { ran++; })).rejects.toBeInstanceOf(Refused);
  expect(ran).toBe(0);
  await intents.perform({ kind: "tile", tile: "tile-lead" }, answer, () => { ran++; });
  await intents.perform({ kind: "person" }, answer, () => { ran++; });
  expect(ran).toBe(2);
  expect(lines()).toEqual([
    { at: expect.any(String), actor: worker, verb: "agent.approve", target: "tile-worker", detail: "allow", outcome: "refused" },
    { at: expect.any(String), actor: { kind: "tile", tile: "tile-lead" }, verb: "agent.approve", target: "tile-worker", detail: "allow", outcome: "ok" },
    { at: expect.any(String), actor: { kind: "person" }, verb: "agent.approve", target: "tile-worker", detail: "allow", outcome: "ok" },
  ]);
});

test("a line says when the intent was asked, not when it ended", async () => {
  const intents = new Intents(new AuditLog({ file }));
  let running = 0;
  await intents.perform(agent, { verb: "agent.await_approval" }, async () => {
    running = Date.now();
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(Date.parse(lines()[0].at)).toBeLessThanOrEqual(running);
});

test("the log is private to its user and appends one line per intent", async () => {
  const log = new AuditLog({ file });
  const intents = new Intents(log);
  await intents.perform(agent, { verb: "agent.send", target: "tile-codex-2" }, () => undefined);
  await intents.perform(agent, { verb: "tile.rename", target: "tile-codex-2" }, () => undefined);
  expect(lines().map((l) => l.verb)).toEqual(["agent.send", "tile.rename"]);
  if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
});

test("past 5 MB the log moves to audit.jsonl.1, replacing the older one, and starts again", async () => {
  const log = new AuditLog({ file });
  const intents = new Intents(log);
  fs.writeFileSync(`${file}.1`, "oldest\n");
  // Room for one more short line: it goes in, and nothing moves.
  fs.writeFileSync(file, `${"x".repeat(MB5 - 200)}\n`);
  await intents.perform(agent, { verb: "agent.send", target: "t" }, () => undefined);
  expect(fs.statSync(file).size).toBeLessThanOrEqual(MB5);
  expect(fs.readFileSync(`${file}.1`, "utf8")).toBe("oldest\n");

  // No room for the next: the full file is kept as .1 and the line starts a new one.
  const full = fs.readFileSync(file, "utf8");
  fs.appendFileSync(file, "y".repeat(MB5 - full.length - 20));
  const before = fs.readFileSync(file, "utf8");
  await intents.perform(agent, { verb: "tile.close", target: "t" }, () => undefined);
  expect(fs.readFileSync(`${file}.1`, "utf8")).toBe(before);
  expect(lines().map((l) => l.verb)).toEqual(["tile.close"]);
});

test("an intent still happens when its line cannot be written, and the failure is said once until a write works again", async () => {
  const warnings: string[] = [];
  const intents = new Intents(new AuditLog({ file, onWarn: (m) => warnings.push(m) }));
  fs.mkdirSync(file); // a directory where the file should be
  expect(await intents.perform(agent, { verb: "agent.send" }, () => "sent")).toBe("sent");
  expect(await intents.perform(agent, { verb: "agent.send" }, () => "sent")).toBe("sent");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(file);

  fs.rmdirSync(file);
  await intents.perform(agent, { verb: "agent.send" }, () => undefined);
  expect(lines()).toHaveLength(1);
  fs.rmSync(file);
  fs.mkdirSync(file);
  await intents.perform(agent, { verb: "agent.send" }, () => undefined);
  expect(warnings).toHaveLength(2);
});
