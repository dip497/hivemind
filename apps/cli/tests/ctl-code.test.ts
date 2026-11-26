/** `hive ctl code` as an agent runs it, each call its own process, on a REAL drive socket over the
 *  host's code domain, its sidecar and the workspace's own TypeScript: lines and columns count from
 *  1 in and out, every answer says how sure it is, and a call without a line is refused with a fix. */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceServer } from "@hivemind/workspace-api/server";
import { tileToken } from "@hivemind/agent-host/hooks/token";
import { serveDrive, type DriveServer } from "@hivemind/host/drive";
import { Grants } from "@hivemind/host/grants";
import { codeIntel, codeSidecar, setCodeSidecar } from "@hivemind/host/code-intel";
import { hiveAsync as hive } from "./helpers.js";

const unix = process.platform !== "win32";
setDefaultTimeout(120_000);
const dir = unix ? fs.realpathSync(fs.mkdtempSync("/tmp/hive-ctl-code-")) : "";
const sock = path.join(dir, "drive.sock");
// A two-file TypeScript project inside this repo, so its TypeScript 7 is the one found.
const repo = path.resolve(import.meta.dir, "..", "..", "..", "packages", "code-intel", "tests", "fixtures", "project");
const TOKEN = "t0k3n";
const env = { HIVE_DRIVE_SOCK: sock, HCP_TOKEN: tileToken(TOKEN, "hm:me-1") };
let drive: DriveServer;
const ctl = (...args: string[]) => hive(["ctl", "code", ...args, "--json"], { env, cwd: repo });

beforeAll(async () => {
  // Against a compiled `hive`, its own sidecar answers, with the grammars it carries.
  if (process.env.HIVE_BIN) setCodeSidecar(() => ({ file: process.env.HIVE_BIN!, args: ["code-sidecar"] }));
  const server = new WorkspaceServer([codeIntel], new Intents(new AuditLog({ file: path.join(dir, "audit.jsonl") })));
  drive = serveDrive(sock, {
    server, installToken: () => TOKEN, grants: new Grants(path.join(dir, "grants.json")), repos: () => [repo],
    workspaceOf: (tile) => (String(tile).endsWith("me-1") ? repo : null), nameOf: () => "me",
  });
  while (!fs.existsSync(sock)) await new Promise((r) => setTimeout(r, 10));
});
afterAll(() => {
  codeSidecar.close();
  drive?.close();
  if (unix) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!unix)("hive ctl code", () => {
  // square.ts:10 is `export const total = areaOf(new Square(2)) + …`: `areaOf` is at column 22, from 1.
  test("definition: the compiler's answer, at the line and column a compiler would print", async () => {
    const r = await ctl("definition", "square.ts:10:22");
    expect(r).toMatchObject({ code: 0, json: { accuracy: "compiler", places: [{ at: "shapes.ts:5:17", file: "shapes.ts", line: 5, col: 17, text: "export function areaOf(shape: Shape): number {" }] } });
  });

  test("usages and hover of the same symbol", async () => {
    const usages = (await ctl("usages", "square.ts:10:22")).json as { accuracy: string; places: { at: string }[] };
    expect(usages.accuracy).toBe("compiler");
    expect(usages.places.map((p) => p.at).sort()).toEqual(["shapes.ts:5:17", "square.ts:10:22", "square.ts:10:46", "square.ts:1:10"]);
    expect(((await ctl("hover", "square.ts:10:22")).json as { text: string }).text).toContain("areaOf(shape: Shape): number");
  });

  test("outline: names, kinds and where each is, members under their class", async () => {
    const r = (await ctl("outline", "square.ts")).json as { accuracy: string; symbols: unknown[] };
    expect(r.accuracy).toBe("syntax");
    expect(r.symbols).toEqual([
      { name: "Square", kind: "class", line: 3, col: 14, endLine: 8, children: [
        { name: "constructor", kind: "constructor", line: 4, col: 3, endLine: 4 },
        { name: "area", kind: "method", line: 5, col: 3, endLine: 7 },
      ] },
      { name: "total", kind: "constant", line: 10, col: 14, endLine: 10 },
    ]);
  });

  test("a question about a place without a line is refused with what to write", async () => {
    const r = await hive(["ctl", "code", "usages", "square.ts"], { env, cwd: repo });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("square.ts:<line>");
  });
});
