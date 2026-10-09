// Scratch: an Ink-like agent's screen after switching to another workspace and back. Not committed.
import { test, expect, _electron as electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedAgents } from "./helpers/agents";
import { stopDaemons } from "./helpers/daemons";

test("switch and back", async () => {
  test.setTimeout(180_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-switch-"));
  const xdg = path.join(root, "config"); const home = path.join(root, "home"); const bin = path.join(root, "bin");
  const cli = path.resolve(process.cwd(), "../cli/src/index.ts");
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  seedAgents(xdg, ["claude"]);
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, HOME: home, HIVEMIND_SHELL_ENV: "0", PATH: `${bin}${path.delimiter}${process.env.PATH}` } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE; delete env.HIVE_HCP_SOCK; delete env.HCP_TOKEN; delete env.HIVEMIND_TILE;
  const repos = ["alpha", "beta"].map((n) => path.join(root, n));
  for (const [i, r] of repos.entries()) { fs.mkdirSync(r); execFileSync("git", ["init", "-q", "-b", "main"], { cwd: r }); execFileSync("bun", [cli, "init", `--prefix=${["AL", "BE"][i]}`, "--no-agentic"], { cwd: r, env }); }
  // An Ink-like agent: a transcript of numbered lines, then a live box redrawn every 80 ms.
  fs.writeFileSync(path.join(bin, "claude"), `#!/usr/bin/env node
if (process.argv[2] === "--version") { console.log("2.0.0 (Claude Code)"); process.exit(0); }
let n = 0; const out = process.stdout;
for (let i = 0; i < 30; i++) out.write("line " + i + " " + "abcdefghij".repeat(12) + "\\n");
out.write("\\n\\n");
setInterval(() => { const w = out.columns; n++; out.write("\\x1b[2A\\r\\x1b[J" + ("> spinner " + n + " ").padEnd(w, "-").slice(0, w) + "\\n" + "auto mode on".padEnd(w, " ").slice(0, w)); out.write("\\n"); }, 80);
`, { mode: 0o755 });
  const app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=${path.join(root, "ud")}`], cwd: repos[0], env });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 820 });
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:spawn-agent")));
  const screen = () => page.evaluate(() => [...document.querySelectorAll(".xterm")].map((x) => ((x.parentElement as unknown as { __hmScreen?: () => string }).__hmScreen?.() ?? "")).join("\n----\n"));
  await expect.poll(screen, { timeout: 20_000 }).toContain("spinner");
  await page.waitForTimeout(1500);
  fs.writeFileSync(path.join(process.env.SHOTS!, "switch-before.txt"), await screen());
  await page.screenshot({ path: path.join(process.env.SHOTS!, "switch-before.png") });
  for (const repo of [repos[1], repos[0]]) {
    await page.evaluate((r) => window.dispatchEvent(new CustomEvent("hivemind:open-workspace", { detail: { repo: r } })), repo);
    await page.waitForTimeout(4000);
  }
  await expect.poll(screen, { timeout: 20_000 }).toContain("spinner");
  await page.waitForTimeout(2000);
  fs.writeFileSync(path.join(process.env.SHOTS!, "switch-after.txt"), await screen());
  await page.screenshot({ path: path.join(process.env.SHOTS!, "switch-after.png") });
  await app.close();
  stopDaemons(xdg);
});
