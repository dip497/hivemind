// The stage every demo recording starts from: the real app in its own home, named "studio", over
// the demo workspace (demo-workspace.sh), with the agents' commands on its PATH. Used by
// capture.spec.ts (the hero) and clips.spec.ts (the short clips); never by the e2e suite.
import { expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HIVE_NET } from "../../tests/e2e/helpers/multiplayer";
import { seedAgents } from "../../tests/e2e/helpers/agents";

export const ROOT = path.resolve("../..");
export const CLI = path.join(ROOT, "apps/cli/src/index.ts");
export const WWW = path.join(ROOT, "crates/hive-web/www");
// Outside any home folder, so no path an agent prints names the person who runs it.
export const DEMO = path.resolve(process.env.DEMO_HOME ?? "/tmp/hivemind-demo");
export const OUT = path.resolve(process.env.DEMO_OUT ?? path.join(os.homedir(), "hivemind-demo-recording"));
export const SIZE = { width: 1600, height: 1000 };
export const BURST = { frames: 8, every: 250 };
export type Box = { x: number; y: number; w: number; h: number };

/** On PATH: the real Claude Code as `claude`, on its owner's login but without their hooks,
 *  plugins, status line or the project's MCP servers, allowed only what the clips need without
 *  asking; and `hive` from this checkout. */
export function agentsOnPath(bin: string): void {
  fs.mkdirSync(bin, { recursive: true });
  const claude = execFileSync("bash", ["-c", "command -v claude"], { encoding: "utf8" }).trim();
  // The hive CLI and commands that read. Edits ask, except in a tile started accepting edits.
  const tools = ["Bash(hive:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(mkdir:*)", "Bash(rg:*)", "Bash(grep:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(ruff check:*)", "Read", "Grep", "Glob"].join(" ");
  fs.writeFileSync(path.join(bin, "claude"), `#!/usr/bin/env bash
[ "$1" = "--version" ] && exec "${claude}" --version
HOME="${os.homedir()}" GIT_CONFIG_GLOBAL="${bin}/gitconfig" exec "${claude}" --setting-sources project,local --strict-mcp-config --allowedTools "${tools}" "$@"
`, { mode: 0o755 });
  // Commits and widget owners under the demo's name, not the name in the runner's git config.
  fs.writeFileSync(path.join(bin, "gitconfig"), "[user]\n\tname = hivemind\n\temail = demo@hivemind.dev\n");
  fs.writeFileSync(path.join(bin, "hive"), `#!/usr/bin/env bash\nexec bun "${CLI}" "$@"\n`, { mode: 0o755 });
}

// Each frame is a folder of the demo workspace: three projects and two worktrees.
export const FOLDERS = {
  fastapi: "fastapi",
  excalidraw: "excalidraw",
  "arrow-binding": "worktrees/excalidraw-arrow-binding",
  ripgrep: "ripgrep",
  "glob-order": "worktrees/ripgrep-glob-order",
} as const;
export type Folder = keyof typeof FOLDERS;

/** The real agents read only the demo's own instructions in these folders, never the runner's. */
export function demoInstructions(folders: Folder[]): void {
  const me = os.homedir();
  for (const f of folders) {
    fs.mkdirSync(path.join(DEMO, FOLDERS[f], ".claude"), { recursive: true });
    fs.writeFileSync(path.join(DEMO, FOLDERS[f], ".claude/settings.local.json"), JSON.stringify({
      claudeMdExcludes: [`${me}/CLAUDE.md`, `${me}/CLAUDE.local.md`, `${me}/.claude/*.md`, `${me}/.claude/rules/**`],
      // Asking before an edit is what the clips show; a tile started in another mode says so.
      permissions: { defaultMode: "default" },
    }, null, 2));
  }
}

/** The runner's own settings, read now; `check` proves nothing the demo did reached them. Other
 *  programs on this machine may write settings.json meanwhile (its plugins, other sessions): what
 *  changed is named, and none of it may carry one of `marks` or touch its permissions. */
export function runnerSettings() {
  const theirs = ["settings.json", "settings.local.json", "CLAUDE.md"].map((f) => path.join(os.homedir(), ".claude", f)).concat(path.join(os.homedir(), ".gitconfig"));
  const read = () => theirs.map((f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : ""));
  const untouched = read();
  return (marks: string[]) => {
    const now = read();
    for (const [i, file] of theirs.entries()) {
      if (now[i] === untouched[i]) continue;
      const ours = marks.filter((mark) => now[i]!.includes(mark) && !untouched[i]!.includes(mark));
      expect(ours, `${file} took the demo's ${ours.join(", ")}`).toEqual([]);
      expect(file, `${file} changed during the recording`).toBe(theirs[0]);
      const was = JSON.parse(untouched[i]!) as Record<string, unknown>;
      const is = JSON.parse(now[i]!) as Record<string, unknown>;
      const keys = [...new Set([...Object.keys(was), ...Object.keys(is)])].filter((k) => JSON.stringify(was[k]) !== JSON.stringify(is[k]));
      console.log(`${file} changed meanwhile, not by the demo: ${keys.join(", ")}`);
      expect(keys, `${file} permissions changed during the recording`).not.toContain("permissions");
    }
  };
}

type Row = { tile: string; state: string; waiting?: { kind: string; says?: string; tool?: { name: string; about?: string } } };
export type Stage = Awaited<ReturnType<typeof stage>>;

/** One person's app on the stage: their own home under `root/<name>`, started in `cwd`, sized and
 *  darkened as the clips show it. `more` joins its environment. */
export async function stage(root: string, apps: ElectronApplication[], { name = "desktop", cwd = path.join(DEMO, "fastapi"), byPackage = false, more = {} as Record<string, string> } = {}) {
  const home = path.join(root, `${name}-home`);
  fs.mkdirSync(home, { recursive: true });
  const profile = 'PS1="\\[\\e[38;5;244m\\]\\W\\[\\e[0m\\] \\$ "\nexport GIT_PAGER=cat PAGER=cat LESS=FRX\n';
  for (const rc of [".bashrc", ".bash_profile"]) fs.writeFileSync(path.join(home, rc), profile);
  fs.writeFileSync(path.join(home, ".hushlogin"), "");
  const bin = path.join(root, "bin");
  if (!fs.existsSync(path.join(bin, "hive"))) agentsOnPath(bin);
  seedAgents(path.join(root, name), ["claude"]);

  // The machine is named "studio" in the picture, not after whoever runs the capture.
  const named = path.join(root, "studio-hostname.so");
  if (!fs.existsSync(named)) {
    execFileSync("gcc", ["-shared", "-fPIC", "-x", "c", "-o", named, "-"], { input: '#include <string.h>\nint gethostname(char *n, unsigned long l) { strncpy(n, "studio", l); return 0; }\n' });
    // The display's cookie is filed under the real name; give it one that any name matches.
    if (process.env.XAUTHORITY) {
      const cookies = execFileSync("xauth", ["nlist"], { encoding: "utf8" }).replace(/^..../gm, "ffff");
      execFileSync("xauth", ["nmerge", "-"], { input: cookies });
    }
  }

  const env = { USER: "hivemind", LOGNAME: "hivemind", LD_PRELOAD: named, HIVEMIND_TEST_UPDATE: "{}", HOME: home, SHELL: "/bin/bash", HIVEMIND_SHELL_ENV: "0", HISTFILE: "/dev/null", PATH: `${bin}:${DEMO}/.tools/bin:${process.env.PATH}`,
    // The runner's Rust toolchain, which the isolated home does not hold.
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? path.join(os.homedir(), ".rustup"), CARGO_HOME: process.env.CARGO_HOME ?? path.join(os.homedir(), ".cargo"), ...more };
  const config = path.join(root, name);
  const launchEnv = { ...process.env, XDG_CONFIG_HOME: config, HIVE_SETTINGS: path.join(config, "settings.json"), HIVEMIND_HIVE_NET: HIVE_NET, ...env } as Record<string, string>;
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  // By its package folder, Electron reads the app's real version, which a machine's installer matches.
  const app = await electron.launch({ args: [byPackage ? path.resolve(".") : path.resolve("out/main/index.js"), "--no-sandbox", "--force-device-scale-factor=2"], cwd, env: launchEnv });
  apps.push(app);
  const desktop = await app.firstWindow();
  await desktop.waitForSelector(".react-flow");
  await app.evaluate(({ BrowserWindow }, s) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    w.unmaximize();
    w.setBounds({ x: 0, y: 0, width: s.width, height: s.height });
  }, SIZE);
  for (const [k, v] of [["appearance.mode", "dark"], ["appearance.terminal.background", "#121416"]] as const) await desktop.evaluate(([a, b]) => window.hive.settingsSet(a, b), [k, v]);

  const userData = fs.readdirSync(path.join(root, name)).map((d) => path.join(root, name, d)).find((d) => fs.existsSync(path.join(d, "hcp.token")))!;
  const hcp = { HIVE_HCP_SOCK: path.join(userData, "hcp.sock"), HCP_TOKEN: fs.readFileSync(path.join(userData, "hcp.token"), "utf8").trim() };
  const cliEnv = { ...process.env, ...env, ...hcp, XDG_CONFIG_HOME: path.join(root, name), HIVE_SETTINGS: path.join(root, name, "settings.json"), HIVEMIND_APP_DATA: userData };
  const cli = (...a: string[]) => spawnSync("bun", [CLI, ...a], { cwd, encoding: "utf8", env: cliEnv });
  const emit = (event: string, detail?: unknown) => desktop.evaluate(([n, d]) => window.dispatchEvent(new CustomEvent(n as string, { detail: d })), [event, detail] as const);
  const lastFrame = () => desktop.$$eval(".react-flow__node-frame", (els) => els.at(-1)?.getAttribute("data-id") ?? "");

  /** One frame per folder, opened as New project opens one; the app was started in the first. */
  const openFrames = async (folders: Folder[]) => {
    const ids = {} as Record<Folder, string>;
    for (const f of folders) {
      if (path.join(DEMO, FOLDERS[f]) === cwd) {
        await emit("hivemind:add-frame");
      } else {
        await app.evaluate((_, dir) => { process.env.HIVEMIND_TEST_PICK_DIR = dir; }, path.join(DEMO, FOLDERS[f]));
        await emit("hivemind:add-project");
      }
      await desktop.waitForTimeout(1200);
      ids[f] = await lastFrame();
      // A frame added in the folder the app opened in starts unnamed; it is named for its folder.
      if (path.join(DEMO, FOLDERS[f]) === cwd) {
        await emit("hivemind:frame-rename", ids[f]);
        const input = desktop.locator(`.react-flow__node[data-id="${ids[f]}"] input`).first();
        if (await input.count()) { await input.fill(f); await input.press("Enter"); }
      }
    }
    return ids;
  };

  const spawn = async (frame: string, label: string, extra: string[]) => {
    for (let i = 0; ; i++) {
      const r = cli("ctl", "spawn", "--agent", "claude", "--name", label, "--frame", frame, ...extra, "--json");
      const tile = JSON.parse(r.stdout || "{}").tile as string | undefined;
      if (tile) return tile;
      // The app limits how fast agents start; wait out the window.
      if (!r.stdout.includes("RATE_LIMITED") || i > 30) throw new Error(`spawn ${label}: ${r.stdout}${r.stderr}`);
      await desktop.waitForTimeout(2000);
    }
  };
  const names: Record<string, string> = {};
  const census = () => {
    const out = cli("ctl", "agents", "--json").stdout;
    let listed: { agents?: Row[] } = {};
    try { listed = JSON.parse(out || "{}"); } catch { console.log(`ctl agents said: ${out.slice(0, 200)}`); }
    const rows = listed.agents ?? [];
    const by: Record<string, number> = {};
    for (const r of rows) by[r.state] = (by[r.state] ?? 0) + 1;
    return { rows, by, of: (tile: string) => rows.find((r) => r.tile === tile) };
  };

  const screen = (tile: string) => cli("ctl", "stream", tile, "--snapshot", "--lines", "40").stdout;
  const show = () => census().rows.map((r) => `${names[r.tile] ?? r.tile}: ${r.state}${r.waiting ? ` (${r.waiting.kind})` : ""}`).join("\n");
  /** A real Claude Code in `frame`, named `label`, asking as `mode` says; once it is ready, given
   *  `job` if there is one. A folder it has not seen asks whether to trust it: the person says yes. */
  const agent = async (frame: string, label: string, mode: "default" | "acceptEdits", job?: string) => {
    const tile = await spawn(frame, label, ["--mode", mode]);
    names[tile] = label;
    for (let i = 0; ; i++) {
      const row = census().of(tile);
      if (row?.waiting?.says === "trust") { cli("ctl", "keys", tile, "Down,Enter"); await desktop.waitForTimeout(2000); }
      else if (row && !row.waiting && row.state !== "starting") break;
      if (i > 60) throw new Error(`${label} never got ready:\n${show()}\n--- its screen:\n${screen(tile).slice(-2500)}`);
      await desktop.waitForTimeout(1000);
    }
    if (job) cli("ctl", "send", tile, job);
    return tile;
  };

  /** Frames set in rows by hand, as a person tidies a board: frames grow as agents land in them. */
  const tidy = async (frames: string[]) => {
    await fit();
    const area = (await desktop.locator(".react-flow").first().boundingBox())!;
    let at = { x: area.x + 16, y: area.y + 80, row: 0 };
    for (const id of frames) {
      const node = desktop.locator(`.react-flow__node[data-id="${id}"]`);
      const b = (await node.boundingBox())!;
      if (at.x + b.width > area.x + area.width - 16) at = { x: area.x + 16, y: at.y + at.row + 12, row: 0 };
      const h = (await node.locator(".frame-drag-handle").first().boundingBox())!;
      const from = { x: h.x + Math.min(24, h.width / 2), y: h.y + h.height / 2 };
      await desktop.mouse.move(from.x, from.y);
      await desktop.mouse.down();
      await desktop.mouse.move(from.x + at.x - b.x, from.y + at.y - b.y, { steps: 12 });
      await desktop.mouse.up();
      await desktop.waitForTimeout(300);
      at = { x: at.x + b.width + 12, y: at.y, row: Math.max(at.row, b.height) };
    }
    await desktop.keyboard.press("Escape");
    await fit();
  };
  /** Notifications already read, cleared as a person clears them. */
  const quiet = () => desktop.evaluate(() => { for (const b of document.querySelectorAll<HTMLButtonElement>('[aria-label="Dismiss notification"]')) b.click(); });
  const fit = async () => {
    await desktop.locator('button[title^="Fit to view"]').first().click();
    await desktop.waitForTimeout(1500);
  };

  return { desktop, app, env, cli, emit, openFrames, agent, census, show, names, tidy, fit, quiet, home };
}

/** Records a clip into `out`: bursts of the app window, single shots of other pages, and the boxes
 *  the camera frames, all written to `out`/cues.json by `save`. File names in the cues are
 *  relative to `base`, the folder the renderer serves. */
export function recorder(app: ElectronApplication, out: string, base = out) {
  fs.rmSync(path.join(out, "frames"), { recursive: true, force: true });
  fs.mkdirSync(path.join(out, "frames"), { recursive: true });
  const t0 = Date.now();
  const shots: { beat: string; files: string[]; at: number[] }[] = [];
  const boxes: Record<string, Box> = {};
  const rel = (file: string) => path.relative(base, path.join(out, file));
  const beat = (name: string) => {
    const s = { beat: name, files: [] as string[], at: [] as number[] };
    shots.push(s);
    return async () => {
      const file = `frames/${name}-${String(s.files.length).padStart(3, "0")}.png`;
      s.at.push(Date.now() - t0);
      const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString("base64"));
      fs.writeFileSync(path.join(out, file), Buffer.from(png, "base64"));
      s.files.push(rel(file));
    };
  };
  const burst = async (name: string, frames = BURST.frames) => {
    const one = beat(name);
    for (let i = 0; i < frames; i++) { await one(); await new Promise((r) => setTimeout(r, BURST.every)); }
  };
  /** A still of another page (a browser, a phone), named `name`. */
  const still = async (page: Page, name: string) => {
    const file = `frames/${name}.png`;
    await page.screenshot({ path: path.join(out, file) });
    shots.push({ beat: name, files: [rel(file)], at: [Date.now() - t0] });
  };
  /** Where `sel` is in the window's capture (twice its CSS pixels). */
  const box = async (page: Page, sel: string, as: string) => {
    const b = (await page.locator(sel).first().boundingBox())!;
    boxes[as] = { x: b.x * 2, y: b.y * 2, w: b.width * 2, h: b.height * 2 };
    return boxes[as]!;
  };
  const save = (more: Record<string, unknown> = {}) => {
    fs.writeFileSync(path.join(out, "cues.json"), JSON.stringify({ size: { width: SIZE.width * 2, height: SIZE.height * 2 }, phone: { width: 780, height: 1688 }, boxes, shots, ...more }, null, 2));
  };
  return { beat, burst, still, box, boxes, shots, save };
}

/** Waits until every one of `tiles` is at its job: working, or asking the person something. */
export async function busy(s: Stage, tiles: string[], timeout = 180_000) {
  await expect.poll(() => tiles.filter((t) => { const r = s.census().of(t); return r?.state === "working" || !!r?.waiting; }).length, { timeout, intervals: [1000] })
    .toBe(tiles.length).catch((e) => { console.log(s.show()); throw e; });
}

/** Answers `tile`'s permission question Yes in the tile itself, only when it asks to run the
 *  command this step expects, as its agent told the app; anything else fails the step and names it. */
export function allow(s: Stage, tile: string, expected: RegExp, approved: string[]) {
  const waiting = s.census().of(tile)?.waiting;
  if (waiting?.kind !== "permission") return;
  const command = waiting.tool?.name === "Bash" ? waiting.tool.about ?? "" : `${waiting.tool?.name ?? "?"}: ${waiting.tool?.about ?? ""}`;
  if (!expected.test(command)) throw new Error(`${s.names[tile] ?? tile} asked to run something this step does not expect, left unanswered: ${JSON.stringify(command)}`);
  console.log(`allowed for ${s.names[tile] ?? tile}: ${command}`);
  approved.push(command);
  s.cli("ctl", "keys", tile, "Enter");
}

/** Waits until every one of `tiles` reports working, or says where each is. */
export async function working(s: Stage, tiles: string[], timeout = 180_000) {
  await expect.poll(() => tiles.filter((t) => s.census().of(t)?.state === "working").length, { timeout, intervals: [1000] })
    .toBe(tiles.length).catch((e) => { console.log(s.show()); throw e; });
}
