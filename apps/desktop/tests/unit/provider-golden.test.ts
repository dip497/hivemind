// Golden tests for the five agent providers (claude, codex, droid, kiro, pi).
//
// Captured BEFORE the provider-catalog consolidation and required to pass
// UNCHANGED after it: for each provider this snapshots the spawn command,
// args, env additions, the injected hook/settings files, the provider-owned
// asset sources (hashed), prompt delivery, command identification, the HCP
// supervise policy, and the status-detector output for a fixed set of PTY
// transcripts. Anything that changes runtime behaviour shows up as a diff.
//
// Regenerate deliberately with `UPDATE_GOLDEN=1 pnpm test:unit` and review the
// fixture diff — never to make a red test green.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { composeResume, composeResumeFrom, PROVIDERS as REGISTRY } from "../../src/main/providers/registry.ts";
import type { SpawnSpec } from "../../src/main/pty-session-manager.ts";
import { droidHooksSettings } from "../../src/main/droid-resume.ts";
import { kiroAgentConfig } from "../../src/main/kiro-resume.ts";
import { piExtSource } from "../../src/main/hcp/pi-ext-source.ts";
import { kiroApprovalHookSource } from "../../src/main/hcp/kiro-approval-hook-source.ts";
import { deliversPromptViaArgv, applyInitialPrompt, INITIAL_PROMPT_ENV } from "../../src/shared/agent-io.ts";
import { identifyAgent, detectTileStatus, type Agent } from "../../src/renderer/src/agent-state.ts";
import { makeDispatch } from "../../src/main/hcp/methods.ts";
import { TurnTracker } from "../../src/main/hcp/turn-tracker.ts";
import { OutputRecorder } from "../../src/main/hcp/output-recorder.ts";
import { Mailbox } from "../../src/main/hcp/mailbox.ts";
import { SUBMIT_DELAY_MS } from "../../src/shared/agent-io.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "provider-golden.json");

/** The daemon-side context, with every path set so every injection fires. */
const CTX = {
  execPath: "/x/electron",
  trackerPath: "/x/ud/tile-session-tracker.cjs",
  tileSessionsDir: "/x/ud/tile-sessions",
  legacyMapFile: "/x/ud/tile-sessions.json",
  planHookPath: "/x/ud/plan-review-hook.cjs",
  planBridgeSock: "/x/ud/plan-bridge.sock",
  stopHookPath: "/x/ud/hcp-stop-hook.cjs",
  approvalHookPath: "/x/ud/hcp-approval-hook.cjs",
  subagentHookPath: "/x/ud/hcp-subagent-hook.cjs",
  notificationHookPath: "/x/ud/hcp-notification-hook.cjs",
  userpromptHookPath: "/x/ud/hcp-userprompt-hook.cjs",
  hcpSock: "/x/ud/hcp.sock",
  hcpToken: "golden-token",
  // Provider-private paths, as each provider's prepare() would return them.
  providers: {
    pi: { piExtPath: "/x/ud/hive-pi-ext.mjs" },
    droid: { droidHome: "/x/ud/droid-home" },
    kiro: { kiroHome: "/x/ud/kiro-home", kiroApprovalHookPath: "/x/ud/hcp-kiro-approval-hook.cjs" },
  },
};

/** One canonical spawn per provider: the UI's command + default args. */
const PROVIDERS: Array<{ id: Agent; cmd: string; defaultArgs: string[]; resumed: string[] }> = [
  { id: "claude", cmd: "claude", defaultArgs: ["--dangerously-skip-permissions"], resumed: ["--resume", "sess-1", "--dangerously-skip-permissions"] },
  { id: "codex", cmd: "codex", defaultArgs: ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"], resumed: ["--sandbox", "workspace-write", "resume", "sess-1"] },
  { id: "droid", cmd: "droid", defaultArgs: [], resumed: ["--resume", "sess-1"] },
  { id: "kiro", cmd: "kiro-cli", defaultArgs: [], resumed: ["chat", "--resume-id", "sess-1"] },
  { id: "pi", cmd: "pi", defaultArgs: [], resumed: ["--session", "sess-1"] },
];

/** Fixed PTY transcripts per provider — the inputs to the status detectors. */
const SCREENS: Record<Agent, string[]> = {
  claude: [
    "❯ ",
    "✻ Thinking… (esc to interrupt)",
    "x\n  1. No\n  2. Yes, allow",
    "Pick:\n↑/↓ to navigate",
    "⠋ Reading files… esc to interrupt",
  ],
  codex: ["allow command?\n[y/n]", "press enter to confirm or esc to cancel", "generating\nesc to interrupt", "• Working (0s • esc…", "❯ "],
  droid: ["EXECUTE rm x\n> Yes, allow\n> No, cancel\nEnter to select", "⠹ Thinking...\n(Press ESC to stop)", "❯ ", "some output\nesc to stop"],
  kiro: ["Allow this tool to run?\nAllow  Deny\nEnter to select", "do you want to proceed?\n❯ yes", "● Editing file…\nesc to cancel", "kiro is working…", "> "],
  pi: ["out\nWorking...", "❯ ", ""],
  // Recognised-but-unspawnable (herdr scrape-only) agents are not providers.
  gemini: [], cursor: [], antigravity: [], cline: [], opencode: [], copilot: [], kimi: [], amp: [], grok: [], hermes: [],
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Normalise a transformed spec: parse `--settings` JSON, blank the random uuid. */
function view(spec: SpawnSpec) {
  const args = [...(spec.args ?? [])];
  const sid = args.indexOf("--session-id");
  if (sid >= 0 && /^[0-9a-f-]{36}$/.test(args[sid + 1] ?? "")) args[sid + 1] = "<uuid>";
  let settings: unknown = undefined;
  const st = args.indexOf("--settings");
  if (st >= 0) { try { settings = JSON.parse(args[st + 1]!); } catch { settings = args[st + 1]; } args[st + 1] = "<settings-json>"; }
  return { cmd: spec.cmd, args, env: spec.env ?? {}, settings };
}

function fakeDeps() {
  const mailbox = new Mailbox(() => true, SUBMIT_DELAY_MS);
  return {
    turns: new TurnTracker(), recorder: new OutputRecorder(),
    callRenderer: async () => ({ tileId: "tile-x" }),
    writeToTile: () => true,
    deliverToTile: (id: string, data: string, onSent?: () => void) => mailbox.deliver(id, data, onSent),
    spawnAllowed: () => true, connect: () => true, disconnect: () => {}, forgetPipes: () => {}, spawnEdge: () => {}, setSupervise: () => {}, pushWait: () => {},
  };
}

async function capture(resume = composeResume(CTX)) {
  // Restore transforms scan the user's session stores under $HOME (codex / pi /
  // droid): point HOME at an empty dir so the snapshot is machine-independent.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "golden-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { dispatch } = makeDispatch(fakeDeps());
    const out: Record<string, unknown> = {};
    for (const p of PROVIDERS) {
      const base: SpawnSpec = { cwd: "/repo", cmd: p.cmd, args: [...p.defaultArgs], cols: 80, rows: 24, env: { HIVE_AGENT_DEPTH: "1" } };
      const supervised: SpawnSpec = { ...base, env: { ...base.env, HIVE_SUPERVISE: "all" } };
      const withPrompt: SpawnSpec = { ...base, env: { ...base.env, [INITIAL_PROMPT_ENV]: "do the thing" } };
      const resumed: SpawnSpec = { ...base, args: [...p.resumed] };
      const spawn = resume.transformSpecOnSpawn(base, "tile-g");
      const promptSpawn = resume.transformSpecOnSpawn(withPrompt, "tile-g");
      const exec = applyInitialPrompt(promptSpawn.args ?? [], promptSpawn.env ?? {});
      let supervise: unknown;
      try { supervise = await dispatch("tile.spawn_agent", { agent: p.id, supervise: "all", callerTile: "parent", report: false }); }
      catch (e) { supervise = { error: (e as { code?: string }).code ?? String(e) }; }
      out[p.id] = {
        identify: { bare: identifyAgent(p.cmd), path: identifyAgent(`/usr/local/bin/${p.cmd} --x`) },
        promptViaArgv: deliversPromptViaArgv(p.id),
        spawn: view(spawn),
        spawnSupervised: view(resume.transformSpecOnSpawn(supervised, "tile-g")),
        spawnWithPrompt: { args: view({ ...promptSpawn, args: exec.args }).args, envHasPrompt: INITIAL_PROMPT_ENV in exec.env },
        restoreFresh: view(resume.transformSpecOnRestore(base, "tile-g")),
        restoreAlreadyResuming: view(resume.transformSpecOnRestore(resumed, "tile-g")),
        retry: (() => { const r = resume.restoreRetryTransform(resume.transformSpecOnRestore(resumed, "tile-g")); return r ? view(r) : null; })(),
        superviseSpawn: supervise,
        status: SCREENS[p.id].map((screen) => ({ screen, status: detectTileStatus(p.id, screen) })),
      };
    }
    out.files = {
      "droid-home/.factory/hooks.json": droidHooksSettings({ execPath: CTX.execPath, stopHookPath: CTX.stopHookPath, userpromptHookPath: CTX.userpromptHookPath, notificationHookPath: CTX.notificationHookPath, hcpSock: CTX.hcpSock }),
      "kiro-home/.kiro/agents/hivemind.json": kiroAgentConfig({ execPath: CTX.execPath, stopHookPath: CTX.stopHookPath, userpromptHookPath: CTX.userpromptHookPath, kiroApprovalHookPath: CTX.providers.kiro.kiroApprovalHookPath, trackerPath: CTX.trackerPath, tileSessionsDir: CTX.tileSessionsDir, hcpSock: CTX.hcpSock }),
    };
    out.assets = {
      "hive-pi-ext.mjs": sha(piExtSource()),
      "hcp-kiro-approval-hook.cjs": sha(kiroApprovalHookSource()),
    };
    return out;
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("provider golden: spawn/restore/retry transforms, injected files, assets, delivery, identification, supervise policy, status detection", async () => {
  // JSON round-trip so `undefined` fields compare like the on-disk fixture.
  const actual = JSON.parse(JSON.stringify(await capture())) as Record<string, unknown>;
  if (process.env.UPDATE_GOLDEN) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, JSON.stringify(actual, null, 2) + "\n");
    return;
  }
  const expected = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  for (const key of Object.keys(expected)) {
    assert.deepEqual(actual[key], expected[key], `golden drift for "${key}" — runtime behaviour changed (UPDATE_GOLDEN=1 only if intended)`);
  }
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
});

test("provider transforms are order-independent: reversed composition matches the golden outputs", async () => {
  const forward = JSON.parse(JSON.stringify(await capture())) as Record<string, unknown>;
  const reversed = JSON.parse(JSON.stringify(await capture(composeResumeFrom([...REGISTRY].reverse(), CTX)))) as Record<string, unknown>;
  for (const key of Object.keys(forward)) {
    const f = forward[key] as Record<string, unknown>, r = reversed[key] as Record<string, unknown>;
    if (f && typeof f === "object") for (const sub of Object.keys(f)) assert.deepEqual(r[sub], f[sub], `order-dependent output at ${key}.${sub} — a provider transform touched a spec it does not own`);
  }
  assert.deepEqual(reversed, forward, "a provider transform touched a spec it does not own — composition must not depend on order");
});
