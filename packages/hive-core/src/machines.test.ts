import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MACHINE_LIMITS, newMachineId, parseMachines, readMachines, resolveMachine, sshDestination,
  validateLabel, validateTarget, writeMachines, type Machine,
} from "./machines.js";

let dir = "";
let file = "";
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-machines-")); file = path.join(dir, "machines.json"); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const m = (over: Partial<Machine> = {}): Machine => ({ id: newMachineId(), label: "build", target: "build-box", enabled: true, ...over });
const code = (fn: () => unknown): string | undefined => { try { fn(); } catch (e) { return (e as { code?: string }).code; } return undefined; };

describe("validateTarget", () => {
  test("accepts aliases, user@host and ssh:// with a port", () => {
    for (const t of ["build-box", "me@10.0.0.4", "ssh://me@host:2222", "ssh://host"]) expect(validateTarget(t)).toBe(t);
  });
  test("rejects option injection, passwords, whitespace and bad ports", () => {
    expect(code(() => validateTarget("-oProxyCommand=touch /tmp/x"))).toBe("machine_target_invalid");
    expect(code(() => validateTarget("ssh://-oProxyCommand=x"))).toBe("machine_target_invalid");
    expect(code(() => validateTarget("ssh://me@-oProxyCommand=x"))).toBe("machine_target_invalid");
    expect(code(() => validateTarget("me@-oProxyCommand=x"))).toBe("machine_target_invalid");
    expect(code(() => validateTarget("me:hunter2@host"))).toBe("machine_target_invalid");
    expect(code(() => validateTarget("ssh://me:hunter2@host:22"))).toBe("machine_target_invalid");
    expect(code(() => validateTarget("host name"))).toBe("machine_target_invalid");
    expect(code(() => validateTarget("host\nx"))).toBe("machine_target_invalid");
    expect(code(() => validateTarget("ssh://host:99999"))).toBe("machine_target_invalid");
    expect(code(() => validateTarget("x".repeat(MACHINE_LIMITS.targetBytes + 1)))).toBe("machine_target_invalid");
  });
  test("an ssh:// path is ignored, quickly even when it is all slashes", () => {
    expect(validateTarget("ssh://me@host:2222/some/path")).toBe("ssh://me@host:2222/some/path");
    const t = performance.now();
    expect(code(() => validateTarget(`ssh://${"/".repeat(MACHINE_LIMITS.targetBytes - 6)}`))).toBe("machine_target_invalid");
    expect(code(() => validateTarget(`ssh://${"/".repeat(50_000)}`))).toBe("machine_target_invalid");
    expect(performance.now() - t).toBeLessThan(100);
  });
});

test("validateLabel caps bytes and control characters", () => {
  expect(validateLabel("  GPU box  ")).toBe("GPU box");
  expect(code(() => validateLabel(""))).toBe("machine_label_invalid");
  expect(code(() => validateLabel("a\u0007b"))).toBe("machine_label_invalid");
  expect(code(() => validateLabel("é".repeat(65)))).toBe("machine_label_invalid"); // 130 bytes
});

test("sshDestination turns ssh:// into -p argv and passes aliases through", () => {
  expect(sshDestination("ssh://me@host:2222")).toEqual(["-p", "2222", "me@host"]);
  expect(sshDestination("ssh://host")).toEqual(["host"]);
  expect(sshDestination("build-box")).toEqual(["build-box"]);
});

describe("parseMachines is strict", () => {
  const doc = (machines: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, machines, ...extra });
  test("round-trips a valid catalog", () => {
    const a = m({ hivePath: "/home/me/.local/bin/hive", platform: "linux-x86_64" });
    expect(parseMachines(doc([a]))).toEqual([a]);
  });
  test("rejects unknown fields, wrong version, duplicates, relative hivePath, oversize", () => {
    const a = m();
    expect(code(() => parseMachines(doc([{ ...a, password: "x" }])))).toBe("machines_invalid");
    expect(code(() => parseMachines(doc([a], { extra: 1 })))).toBe("machines_invalid");
    expect(code(() => parseMachines(JSON.stringify({ version: 2, machines: [] })))).toBe("machines_invalid");
    expect(code(() => parseMachines(doc([a, a])))).toBe("machines_invalid");
    expect(code(() => parseMachines(doc([{ ...a, hivePath: "bin/hive" }])))).toBe("machines_invalid");
    expect(code(() => parseMachines(doc([{ ...a, id: "build" }])))).toBe("machines_invalid");
    expect(code(() => parseMachines(doc(Array.from({ length: MACHINE_LIMITS.machines + 1 }, () => m()))))).toBe("machines_invalid");
    expect(code(() => parseMachines(" ".repeat(MACHINE_LIMITS.fileBytes + 1)))).toBe("machines_invalid");
    expect(code(() => parseMachines("{"))).toBe("machines_invalid");
  });
});

describe("read/write", () => {
  test("missing file reads as empty; write is atomic, private and re-readable", async () => {
    expect(await readMachines(file)).toEqual([]);
    const list = [m(), m({ label: "gpu", target: "ssh://me@gpu:2200" })];
    await writeMachines(list, file);
    expect(await readMachines(file)).toEqual(list);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
  test("refuses to write through a symlink", async () => {
    const real = path.join(dir, "elsewhere.json");
    fs.writeFileSync(real, "{}");
    fs.symlinkSync(real, file);
    await expect(writeMachines([m()], file)).rejects.toMatchObject({ code: "machines_unwritable" });
    expect(fs.readFileSync(real, "utf8")).toBe("{}");
  });
  test("a corrupt file is an error, not an empty catalog", async () => {
    fs.writeFileSync(file, "{not json");
    await expect(readMachines(file)).rejects.toMatchObject({ code: "machines_invalid" });
  });
});

test("resolveMachine: id wins, exact label, ambiguity is an error", () => {
  const a = m({ label: "gpu" }), b = m({ label: "build" }), c = m({ label: "build" });
  expect(resolveMachine([a, b], a.id)).toBe(a);
  expect(resolveMachine([a, b], "gpu")).toBe(a);
  expect(code(() => resolveMachine([a, b, c], "build"))).toBe("machine_ambiguous");
  expect(code(() => resolveMachine([a], "nope"))).toBe("machine_not_found");
});
