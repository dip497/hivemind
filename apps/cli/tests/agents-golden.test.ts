/** Golden for the CLI's view of agent providers — captured before the
 *  provider-catalog consolidation, must pass unchanged after it. */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAssignee } from "../src/parse.js";
import { hive } from "./helpers.js";

const IDS = ["claude", "codex", "droid", "kiro", "kiro-cli", "pi", "opencode", "gemini", "sarah"];

describe("agents golden", () => {
  test("parseAssignee: which ids resolve as agents", () => {
    expect(Object.fromEntries(IDS.map((id) => [id, parseAssignee(id)?.type]))).toEqual({
      claude: "agent", codex: "agent", droid: "member", kiro: "agent", "kiro-cli": "member", pi: "agent", opencode: "agent", gemini: "agent", sarah: "member",
    });
  });

  test("hive agent detect: which binaries it probes for", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "hive-agents-ws-"));
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "hive-agents-bin-"));
    fs.mkdirSync(path.join(ws, ".hivemind", "issues"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".hivemind", "config.yaml"), "prefix: AG\nnext_id: 1\nagents: {}\n");
    for (const b of ["claude", "codex", "droid", "kiro-cli", "kiro", "pi", "opencode", "gemini", "amp", "cursor", "hermes", "openclaw", "vim"]) {
      fs.writeFileSync(path.join(bin, b), "#!/bin/sh\n"); fs.chmodSync(path.join(bin, b), 0o755);
    }
    const r = hive(["agent", "detect", "--json"], { cwd: ws, env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, XDG_CONFIG_HOME: path.join(ws, "xdg") } });
    expect(r.code).toBe(0);
    expect(Object.keys((r.json as { data: Record<string, unknown> }).data).sort()).toEqual(
      ["amp", "claude", "codex", "cursor", "gemini", "hermes", "kiro-cli", "openclaw", "opencode", "pi"],
    );
    fs.rmSync(ws, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true });
  });
});
