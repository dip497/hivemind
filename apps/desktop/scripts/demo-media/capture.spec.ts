// The demo's frames, recorded once from the real app, the real phone page paired with it and real
// agents, over the demo workspace (demo-workspace.sh). Run by demo-media.mjs, never by the e2e
// suite. See docs/design/demo-media-2026-10-18.md.
import { test, expect, chromium, type ElectronApplication } from "@playwright/test";
import { execFileSync, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hiveNetBuilt, ownNetwork, person } from "../../tests/e2e/helpers/multiplayer";
import { connectPage, offerToConnect } from "../../tests/e2e/helpers/phone";
import { seedAgents } from "../../tests/e2e/helpers/agents";
import { stopDaemons } from "../../tests/e2e/helpers/daemons";

const ROOT = path.resolve("../..");
const CLI = path.join(ROOT, "apps/cli/src/index.ts");
const WWW = path.join(ROOT, "crates/hive-web/www");
// Outside any home folder, so no path an agent prints names the person who runs it.
const DEMO = path.resolve(process.env.DEMO_HOME ?? "/tmp/hivemind-demo");
const OUT = path.resolve(process.env.DEMO_OUT ?? path.join(os.homedir(), "hivemind-demo-recording"));
const SIZE = { width: 1600, height: 1000 };
const BURST = { frames: 8, every: 250 };
// What the person types to the agent in the hero, and what the agent on the phone is asked.
const ASK_WIDGET = "Make a board widget for FAS-1 with hive widgets new, and tick it off as you go";
const ASK_EDIT = "Add a short docstring to generate_encoders_by_class_tuples in fastapi/encoders.py";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-demo-"));
const apps: ElectronApplication[] = [];
const procs: ChildProcess[] = [];
test.afterAll(async () => {
  for (const a of apps) await Promise.race([a.close(), new Promise((r) => setTimeout(r, 8000))]);
  for (const p of procs) p.kill("SIGKILL");
  stopDaemons(root);
});

/** On PATH under the agents' names. A tile started with a scene script (it ends in a long sleep)
 *  is a stand-in that prints real command output and the screen its manifest's detector reads.
 *  Any other `claude` is the real Claude Code, on its owner's login but without their hooks,
 *  plugins, status line or the project's MCP servers. */
function agentsOnPath(bin: string): void {
  fs.mkdirSync(bin, { recursive: true });
  const realClaude = execFileSync("bash", ["-c", "command -v claude"], { encoding: "utf8" }).trim();
  const tools = ["Bash(hive:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(mkdir:*)", "Bash(rg:*)", "Bash(grep:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git remote:*)", "Bash(gh api user:*)", "Bash(python3:*)", "Bash(ruff:*)", "Bash(head:*)", "Bash(cp:*)", "Read", "Grep", "Glob"].join(" ");
  for (const cli of ["claude", "codex", "pi"]) {
    const real = cli === "claude"
      ? `[ "$1" = "--version" ] && exec "${realClaude}" --version
HOME="${os.homedir()}" GIT_CONFIG_GLOBAL="${bin}/gitconfig" exec "${realClaude}" --setting-sources project,local --strict-mcp-config --allowedTools "${tools}" "$@"`
      : `[ "$1" = "--version" ] && { echo "0.0.0 (demo stand-in)"; exit 0; }
printf '\\n❯ '; IFS= read -r line; clear; exec bash -c "$line"`;
    fs.writeFileSync(path.join(bin, cli), `#!/usr/bin/env bash
cmd=""
for a in "$@"; do case "$a" in *"sleep 3600") cmd="$a" ;; esac; done
if [ -n "$cmd" ]; then clear; exec bash -c "$cmd"; fi
${real}
`, { mode: 0o755 });
  }
  // Commits and widget owners under the demo's name, not the name in the runner's git config.
  fs.writeFileSync(path.join(bin, "gitconfig"), "[user]\n\tname = hivemind\n\temail = demo@hivemind.dev\n");
  fs.writeFileSync(path.join(bin, "hive"), `#!/usr/bin/env bash\nexec bun "${CLI}" "$@"\n`, { mode: 0o755 });
}

const WORKING = {
  claude: (task: string) => `(i=0; while :; do for g in ✻ ✶ ✳ ✢; do i=$((i+1)); printf '\\r%s ${task}… (%ss · esc to interrupt)  ' "$g" $((i*4/10)); sleep 0.4; done; done)`,
  codex: (task: string) => `(i=0; while :; do i=$((i+1)); printf '\\r• Working (%ss) · ${task}  ' $((i*4/10)); sleep 0.4; done)`,
  pi: (task: string) => `(i=0; while :; do i=$((i+1)); printf '\\rWorking... ${task} (%ss)  ' $((i*4/10)); sleep 0.4; done)`,
};
type Kind = keyof typeof WORKING;
const work = (kind: Kind, cmd: string, task: string) => `clear; ${cmd} 2>&1 | head -n 18; printf '\\n'; ${WORKING[kind](task)}`;

// Each frame is a folder of the demo workspace: three projects and two worktrees.
const FOLDERS = {
  fastapi: "fastapi",
  excalidraw: "excalidraw",
  "arrow-binding": "worktrees/excalidraw-arrow-binding",
  ripgrep: "ripgrep",
  "glob-order": "worktrees/ripgrep-glob-order",
} as const;
type Folder = keyof typeof FOLDERS;
const SCENE: [Folder, Kind, string, string][] = [
  ["fastapi", "codex", "routing", work("codex", "git log --oneline -n 12 -- fastapi/routing.py", "Reading the router history")],
  ["fastapi", "pi", "params", work("pi", "rg -n '^class ' fastapi/params.py", "Mapping the parameter classes")],
  ["fastapi", "claude", "tutorial", work("claude", "ls docs/en/docs/advanced | head -n 14", "Typing the advanced tutorial")],
  ["excalidraw", "claude", "export", work("claude", "rg -n 'exportScale' packages --max-count 1 | head -n 12", "Adding 3x export")],
  ["excalidraw", "codex", "hit-test", work("codex", "rg -n 'hitElementItself' packages | head -n 10", "Profiling hit testing")],
  ["excalidraw", "pi", "packages", work("pi", "ls packages", "Reading the packages")],
  ["excalidraw", "claude", "history", work("claude", "git log --oneline -n 12", "Reading recent changes")],
  ["arrow-binding", "claude", "binding", work("claude", "git diff --stat; rg -n 'export const bindLinearElement' packages", "Fixing rotated bindings")],
  ["arrow-binding", "codex", "binding-test", work("codex", "rg -n 'describe\\(' packages/element/tests/binding.test.tsx | head -n 12", "Writing the rotation test")],
  ["arrow-binding", "pi", "binding-review", work("pi", "git log --oneline -n 8 -- packages/element/src/binding.ts", "Reviewing the binding code")],
  ["arrow-binding", "claude", "binding-docs", work("claude", "git status --short", "Checking the branch")],
  ["ripgrep", "codex", "count-types", work("codex", "rg -n 'count' crates/core/flags/defs.rs --max-count 1 | head -n 12", "Counting by file type")],
  ["ripgrep", "claude", "searcher", work("claude", "wc -l crates/*/src/*.rs | sort -n | tail -n 12", "Sizing the crates")],
  ["ripgrep", "pi", "ignore", work("pi", "git log --oneline -n 12 -- crates/ignore", "Reading the ignore crate")],
  ["ripgrep", "claude", "printer", work("claude", "ls crates/printer/src", "Reading the printer")],
  ["glob-order", "claude", "guide", work("claude", "git diff --stat; git diff | head -n 14", "Writing the glob section")],
  ["glob-order", "codex", "glob-flags", work("codex", "rg -n 'iglob' crates/core/flags/defs.rs | head -n 10", "Checking the glob flags")],
  ["glob-order", "pi", "examples", work("pi", "rg -n '\\-\\-glob' GUIDE.md | head -n 12", "Testing the examples")],
];

test("capture", async () => {
  test.skip(!hiveNetBuilt() || !fs.existsSync(path.join(WWW, "main.js")), "build hive-net and the phone page first");
  test.skip(!fs.existsSync(path.join(DEMO, "fastapi/.hivemind")), "run demo-workspace.sh first");
  test.setTimeout(1_500_000);
  fs.rmSync(path.join(OUT, "frames"), { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, "frames"), { recursive: true });

  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const profile = 'PS1="\\[\\e[38;5;244m\\]\\W\\[\\e[0m\\] \\$ "\nexport GIT_PAGER=cat PAGER=cat LESS=FRX\n';
  for (const rc of [".bashrc", ".bash_profile"]) fs.writeFileSync(path.join(home, rc), profile);
  fs.writeFileSync(path.join(home, ".hushlogin"), "");
  const bin = path.join(root, "bin");
  agentsOnPath(bin);
  // The real agents read only the demo's own instructions, never the runner's.
  const me = os.homedir();
  fs.mkdirSync(path.join(DEMO, "fastapi/.claude"), { recursive: true });
  fs.writeFileSync(path.join(DEMO, "fastapi/.claude/settings.local.json"), JSON.stringify({
    claudeMdExcludes: [`${me}/CLAUDE.md`, `${me}/CLAUDE.local.md`, `${me}/.claude/*.md`, `${me}/.claude/rules/**`],
    // Asking before an edit is what the phone clip shows; a tile started in another mode says so.
    permissions: { defaultMode: "default" },
  }, null, 2));
  seedAgents(path.join(root, "desktop"), ["claude", "codex", "pi"]);

  // The machine is named "studio" in the picture, not after whoever runs the capture.
  const named = path.join(root, "studio-hostname.so");
  execFileSync("gcc", ["-shared", "-fPIC", "-x", "c", "-o", named, "-"], { input: '#include <string.h>\nint gethostname(char *n, unsigned long l) { strncpy(n, "studio", l); return 0; }\n' });
  // The display's cookie is filed under the real name; give it one that any name matches.
  if (process.env.XAUTHORITY) {
    const cookies = execFileSync("xauth", ["nlist"], { encoding: "utf8" }).replace(/^..../gm, "ffff");
    execFileSync("xauth", ["nmerge", "-"], { input: cookies });
  }

  const net = await ownNetwork(root, procs, "closed", WWW);
  const env = { USER: "hivemind", LOGNAME: "hivemind", LD_PRELOAD: named, HIVEMIND_TEST_UPDATE: "{}", HOME: home, SHELL: "/bin/bash", HIVEMIND_SHELL_ENV: "0", HISTFILE: "/dev/null", PATH: `${bin}:${process.env.PATH}` };
  const desktop = await person(root, "desktop", path.join(DEMO, "fastapi"), apps, env, ["--force-device-scale-factor=2"]);
  const app = apps[0]!;
  await app.evaluate(({ BrowserWindow }, s) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    w.unmaximize();
    w.setBounds({ x: 0, y: 0, width: s.width, height: s.height });
  }, SIZE);
  expect(await desktop.evaluate((l) => window.hive.useNetwork(l), net.link)).toMatchObject({ admission: "enrolled" });
  for (const [k, v] of [["appearance.mode", "dark"], ["appearance.terminal.background", "#121416"]] as const) await desktop.evaluate(([a, b]) => window.hive.settingsSet(a, b), [k, v]);

  const userData = fs.readdirSync(path.join(root, "desktop")).map((d) => path.join(root, "desktop", d)).find((d) => fs.existsSync(path.join(d, "hcp.token")))!;
  const hcp = { HIVE_HCP_SOCK: path.join(userData, "hcp.sock"), HCP_TOKEN: fs.readFileSync(path.join(userData, "hcp.token"), "utf8").trim() };
  const cli = (...a: string[]) => spawnSync("bun", [CLI, ...a], { cwd: path.join(DEMO, "fastapi"), encoding: "utf8", env: { ...process.env, ...env, ...hcp, XDG_CONFIG_HOME: path.join(root, "desktop"), HIVE_SETTINGS: path.join(root, "desktop", "settings.json"), HIVEMIND_APP_DATA: userData } });
  const emit = (name: string, detail?: unknown) => desktop.evaluate(([n, d]) => window.dispatchEvent(new CustomEvent(n as string, { detail: d })), [name, detail] as const);
  const lastFrame = () => desktop.$$eval(".react-flow__node-frame", (els) => els.at(-1)?.getAttribute("data-id") ?? "");

  // One frame per folder, opened as New project opens one; the app was started in fastapi.
  const frameIds = {} as Record<Folder, string>;
  for (const f of Object.keys(FOLDERS) as Folder[]) {
    if (f === "fastapi") {
      await emit("hivemind:add-frame");
    } else {
      await app.evaluate((_, dir) => { process.env.HIVEMIND_TEST_PICK_DIR = dir; }, path.join(DEMO, FOLDERS[f]));
      await emit("hivemind:add-project");
    }
    await desktop.waitForTimeout(1200);
    frameIds[f] = await lastFrame();
    if (f === "fastapi") {
      await emit("hivemind:frame-rename", frameIds[f]);
      const input = desktop.locator(`.react-flow__node[data-id="${frameIds[f]}"] input`).first();
      if (await input.count()) { await input.fill("fastapi"); await input.press("Enter"); }
    }
  }

  const spawn = async (frame: Folder, kind: Kind, name: string, extra: string[]) => {
    for (let i = 0; ; i++) {
      const r = cli("ctl", "spawn", "--agent", kind, "--name", name, "--frame", frameIds[frame], ...extra, "--json");
      const tile = JSON.parse(r.stdout || "{}").tile as string | undefined;
      if (tile) return tile;
      // The app limits how fast agents start; wait out the window.
      if (!r.stdout.includes("RATE_LIMITED") || i > 30) throw new Error(`spawn ${name}: ${r.stdout}${r.stderr}`);
      await desktop.waitForTimeout(2000);
    }
  };
  // The two real agents: one builds the widget in the hero, one asks before an edit on the phone.
  const builder = await spawn("fastapi", "claude", "release-board", ["--mode", "acceptEdits"]);
  const asker = await spawn("fastapi", "claude", "encoders-docs", ["--mode", "default"]);
  const names: Record<string, string> = { [builder]: "release-board", [asker]: "encoders-docs" };
  for (const [frame, kind, name, script] of SCENE) names[await spawn(frame, kind, name, ["--prompt", `${script}; sleep 3600`])] = name;

  type Row = { tile: string; state: string; waiting?: { kind: string; says?: string } };
  const census = () => {
    const out = cli("ctl", "agents", "--json").stdout;
    let listed: { agents?: Row[] } = {};
    try { listed = JSON.parse(out || "{}"); } catch { console.log(`ctl agents said: ${out.slice(0, 200)}`); }
    const rows = listed.agents ?? [];
    const by: Record<string, number> = {};
    for (const r of rows) by[r.state] = (by[r.state] ?? 0) + 1;
    return { rows, by, of: (tile: string) => rows.find((r) => r.tile === tile) };
  };
  const show = () => census().rows.map((r) => `${names[r.tile] ?? r.tile}: ${r.state}${r.waiting ? ` (${r.waiting.kind})` : ""}`).join("\n");

  // A real Claude in a folder it has not seen asks whether to trust it; the person says yes.
  const settle = async (tile: string) => {
    for (let i = 0; i < 60; i++) {
      const row = census().of(tile);
      if (row?.waiting?.says === "trust") { cli("ctl", "keys", tile, "Down,Enter"); await desktop.waitForTimeout(2000); }
      else if (row && !row.waiting && row.state !== "starting") return;
      await desktop.waitForTimeout(1000);
    }
    await emit("hivemind:focus-tile", tile);
    await desktop.waitForTimeout(1500);
    await desktop.screenshot({ path: path.join(OUT, "frames/unsettled.png") });
    throw new Error(`${names[tile]} never settled:\n${show()}\n--- its screen:\n${cli("ctl", "read", tile, "--poll").stdout.slice(-2500)}`);
  };
  await settle(builder);
  await settle(asker);
  await expect.poll(() => census().by.working ?? 0, { timeout: 90_000, intervals: [1000] }).toBeGreaterThanOrEqual(17).catch((e) => { console.log(show()); throw e; });

  // The phone page, paired as a person pairs it.
  const link = await offerToConnect(desktop, true);
  const browser = await chromium.launch();
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark" })).newPage();
  await phone.goto(link);
  await connectPage(phone, desktop);
  await desktop.keyboard.press("Escape");
  await desktop.waitForTimeout(800);

  // Frames grow as agents land in them; set them in rows by hand, as a person tidies a board.
  const fit = async () => {
    await desktop.locator('button[title^="Fit to view"]').first().click();
    await desktop.waitForTimeout(1500);
  };
  await fit();
  const area = (await desktop.locator(".react-flow").first().boundingBox())!;
  let at = { x: area.x + 16, y: area.y + 80, row: 0 };
  for (const f of Object.keys(FOLDERS) as Folder[]) {
    const node = desktop.locator(`.react-flow__node[data-id="${frameIds[f]}"]`);
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

  const t0 = Date.now();
  const shots: { beat: string; files: string[]; at: number[] }[] = [];
  const shoot = async (file: string) => {
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString("base64"));
    fs.writeFileSync(path.join(OUT, file), Buffer.from(png, "base64"));
  };
  const beat = (name: string) => {
    const s = { beat: name, files: [] as string[], at: [] as number[] };
    shots.push(s);
    return async () => {
      const file = `frames/${name}-${String(s.files.length).padStart(3, "0")}.png`;
      s.at.push(Date.now() - t0);
      await shoot(file);
      s.files.push(file);
    };
  };
  const burst = async (name: string) => {
    const one = beat(name);
    for (let i = 0; i < BURST.frames; i++) { await one(); await desktop.waitForTimeout(BURST.every); }
  };
  const phoneShot = async (name: string) => {
    const file = `frames/phone-${name}.png`;
    await phone.screenshot({ path: path.join(OUT, file) });
    shots.push({ beat: `phone-${name}`, files: [file], at: [Date.now() - t0] });
  };
  const box = async (sel: string) => {
    const b = (await desktop.locator(sel).first().boundingBox())!;
    return { x: b.x * 2, y: b.y * 2, w: b.width * 2, h: b.height * 2 };
  };
  const tile = (id: string) => `.react-flow__node[data-id="${id}"]`;

  // 1. The board: many agents at work.
  const before = census();
  await burst("working");
  const boxes: Record<string, { x: number; y: number; w: number; h: number }> = { builderWide: await box(tile(builder)) };

  // 2. Close on the builder; the pointer rests beside it, where a board widget lands.
  await emit("hivemind:focus-tile", builder);
  await desktop.waitForTimeout(1500);
  await desktop.locator('button[title^="Zoom out"]').first().click();
  await desktop.waitForTimeout(1200);
  boxes.builderClose = await box(tile(builder));
  await burst("builder-close");

  // 3. The person types one line to it.
  await desktop.locator(`${tile(builder)} .xterm`).first().click();
  const beside = { x: boxes.builderClose.x / 2 + boxes.builderClose.w / 2 + 40, y: boxes.builderClose.y / 2 + 20 };
  await desktop.mouse.move(beside.x, beside.y, { steps: 4 });
  const typing = beat("typing");
  for (const word of ASK_WIDGET.split(" ")) {
    await desktop.keyboard.type(`${word} `, { delay: 30 });
    await typing();
  }
  await desktop.keyboard.press("Enter");

  // 4. It builds, installs and places the widget, then works the issue, ticking it.
  const criteria = () => {
    try { return (JSON.parse(cli("show", "FAS-1", "--json").stdout).data.sections.acceptanceCriteria ?? []) as { done: boolean; text: string }[]; } catch { return []; }
  };
  const issueDone = () => { const c = criteria(); return c.length > 0 && c.every((x) => x.done); };
  const building = beat("building");
  const states: string[] = [];
  let widget = "";
  let doneAt = 0;
  for (const started = Date.now(); Date.now() - started < 12 * 60_000;) {
    await building();
    const row = census().of(builder);
    // A person who looks over now and then: Claude's own "proceed?" menu, still open, gets a yes.
    if (row?.waiting?.kind === "permission" && /Do you want to proceed\?/.test(cli("ctl", "stream", builder, "--snapshot", "--lines", "14").stdout)) {
      await desktop.waitForTimeout(2500);
      cli("ctl", "keys", builder, "1");
      states.push(`${Math.round((Date.now() - started) / 1000)}s answered yes`);
    }
    const state = `${row?.state}${row?.waiting ? ` ${row.waiting.kind}/${row.waiting.says ?? ""}` : ""}`;
    if (states.at(-1)?.endsWith(` ${state}`) !== true) states.push(`${Math.round((Date.now() - started) / 1000)}s ${state}`);
    if (!widget) {
      const listed = JSON.parse(cli("ctl", "plugin", "list", "--json").stdout || "{}") as { plugins?: { plugin: string; kind: string; state: string }[] };
      widget = listed.plugins?.find((p) => p.kind === "widget" && p.state === "ready")?.plugin ?? "";
    }
    // Done when the issue says so and the agent has stopped: then a few seconds more.
    if (widget && !doneAt && row?.state !== "working" && issueDone()) doneAt = Date.now();
    if (doneAt && Date.now() - doneAt > 5000) break;
    await desktop.waitForTimeout(700);
  }
  const ticked = criteria();
  boxes.widgetClose = await box(".react-flow__node-widget").catch(() => ({ x: 0, y: 0, w: 0, h: 0 }));
  await burst("built-close");
  await desktop.keyboard.press("Escape");
  await fit();
  await burst("built");
  const afterBuild = census();

  // 5. The phone clip: the other agent asks before an edit, and the person allows it there.
  cli("ctl", "send", asker, ASK_EDIT);
  await expect.poll(() => census().of(asker)?.waiting?.kind ?? "", { timeout: 300_000, intervals: [1000] }).toBe("permission").catch((e) => { console.log(show()); throw e; });
  await desktop.waitForTimeout(1200);
  const asking = census();
  await burst("asking");
  boxes.askerWide = await box(tile(asker));
  await emit("hivemind:focus-tile", asker);
  await desktop.waitForTimeout(1500);
  await burst("asking-close");
  await phone.waitForTimeout(1500);
  await phoneShot("needs");
  await phone.getByText("encoders-docs").first().click({ timeout: 15_000 });
  await phone.waitForTimeout(1200);
  await phoneShot("asks");
  const allow = phone.getByRole("button", { name: /^allow/i }).first();
  const ab = (await allow.boundingBox())!;
  boxes.allow = { x: ab.x * 2, y: ab.y * 2, w: ab.width * 2, h: ab.height * 2 };
  await allow.click();
  await expect.poll(() => census().of(asker)?.waiting?.kind ?? "", { timeout: 30_000 }).toBe("");
  await phone.waitForTimeout(2500);
  await phoneShot("answered");
  await burst("answered-close");
  await browser.close();

  const cues = {
    size: { width: SIZE.width * 2, height: SIZE.height * 2 }, phone: { width: 780, height: 1688 },
    asked: { widget: ASK_WIDGET, edit: ASK_EDIT },
    census: { before: before.by, afterBuild: afterBuild.by, asking: asking.by },
    widget: { id: widget, list: ticked, states },
    boxes,
    shots,
  };
  fs.writeFileSync(path.join(OUT, "cues.json"), JSON.stringify(cues, null, 2));
  // The scene each clip promises: many agents at work, a widget the agent built and ticked, one
  // agent waiting on the phone.
  expect(before.by.working ?? 0, show()).toBeGreaterThanOrEqual(16);
  expect(widget, "the agent put a widget on the board").not.toBe("");
  expect(asking.of(asker)?.waiting?.kind).toBe("permission");
});
