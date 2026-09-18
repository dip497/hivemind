// The manifests that ship in the box: the bundle is built from them, and nothing a
// manifest cannot back is allowed through the loader. What each detector answers is
// pinned separately, in detector-golden.test.ts.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { getCatalog, spawnArgsFor, spawnLabelFor } from "../src/catalog.js";
import { BUNDLED_AGENTS } from "../src/bundled-manifests.js";
import { agentDisclosures, defFromManifest, ManifestError, AGENT_MANIFEST_VERSION } from "../src/manifest.js";
import { RESERVED_AGENTS } from "../src/reserved.js";
import { NODE_PARTS, PLUGINS } from "../src/node.js";
import type { AgentProviderDef, SpawnOptions } from "../src/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "..", "manifests");

function loadManifest(id: string): AgentProviderDef {
  const raw = YAML.parse(readFileSync(join(DIR, `${id}.yaml`), "utf8")) as unknown;
  return defFromManifest(raw, { trusted: true, nodeHalf: !!NODE_PARTS[id] });
}

const MODES = [undefined, "default", "plan", "acceptEdits", "bypassPermissions", "ask"];
const MODELS = [undefined, "default", "opus", "gpt-5"];

// Shapes fuzzing won't produce; without them some rules are never exercised.
const SEEDS = [
  "↑ 1.2k tokens", "↓ 18.3k tokens", "(1.2k tokens", "· 900 tokens", "↑ 12 tokens",
  "• Working (0s • esc…", "  • Working (12s)", "• working (0s)",
  "✻ Thinking… (esc to interrupt)", "⠋ Reading files… esc to interrupt",
  "x\n  1. No\n  2. Yes, allow", "Pick:\n↑/↓ to navigate", "❯ ",
  "(6m 41s · thinking)", "(12s · 1.2k tokens)", "⏵⏵ bypass permissions",
  "⏵⏵ accept edits\n│ box", "waiting for 3 background agents to finish",
  "⬡ Generating…", "⬢ Thinking...", "⠿ Searching…", "◔ analysing esc to cancel",
  "  (y) allow", "run (once) (y)", "→ run (y)", "△ Permission required",
  "/tasks 3 tasks", "/tasks 0 tasks", "  tab amend\nrequesting permission for:",
  "EXECUTE\n> yes, allow", "kiro is working", "cline is ready for your message",
  "[act mode] yes", "let cline use this tool", "Working...",
];

// ── corpus: seeds + deterministic fuzz from the rules' own literals
function corpusFor(): string[] {
  const pool = new Set<string>([
    "", " ", "foo bar", "❯ ", "> ", "│ ", "  ", "src/index.ts",
    "esc to interrupt", "esc to cancel", "esc to stop", "ctrl+c to stop",
    "do you want to proceed?", "would you like to continue", "yes", "no",
    "[y/n]", "(y/n)", "(y) (enter)", "allow", "deny", "trust", "reject",
    "2. Yes, allow", "1. No", "Press Enter", "Enter to select", "↑/↓ to navigate",
    "⏵⏵ accept edits", "waiting for 2 background agents", "1.2k tokens", "(12s ·",
    "⠋ Reading files…", "⬡ Thinking...", "◔ running", "• Working (0s)",
    "△ Permission required", "↑↓ select", "⇆ tab", "esc dismiss", "enter confirm",
    "/tasks 3 tasks", "/tasks 0 task", "requesting permission for:", "tab amend",
    "Working...", "EXECUTE", "> yes, allow", "kiro is working", "run (once)",
    "waiting for approval", "approve", "deny with feedback", "invoke tool",
    "let cline use this tool", "[act mode]", "cline is ready for your message",
    "thinking", "processing", "msg=interrupt", "ctrl+c cancel", "ctrl+o:yolo",
    "✻ Cogitating…", "confirm with", "enter",
  ]);
  for (const f of readdirSync(DIR).filter((n) => n.endsWith(".yaml"))) {
    for (const m of readFileSync(join(DIR, f), "utf8").matchAll(/contains(?:CS)?: (.+)/g)) {
      pool.add(m[1]!.replace(/^["']|["']$/g, ""));
    }
  }
  const POOL = [...pool];
  let seed = 20260910;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out: string[] = [...SEEDS];
  for (let i = 0; i < 8000; i++) {
    const lines: string[] = [];
    const n = 1 + Math.floor(rnd() * (rnd() < 0.2 ? 26 : 5));
    for (let j = 0; j < n; j++) {
      let l = "";
      for (let t = 0, k = 1 + Math.floor(rnd() * 3); t < k; t++) {
        let tok = POOL[Math.floor(rnd() * POOL.length)]!;
        if (rnd() < 0.2) tok = tok.toUpperCase();
        l += tok + (rnd() < 0.7 ? " " : "");
      }
      if (rnd() < 0.25) l = "  " + l;
      if (rnd() < 0.08) l = "";
      lines.push(l);
    }
    out.push(lines.join("\n"));
  }
  return out;
}
const CORPUS = corpusFor();

describe("the agents that ship in the box", () => {
  test("every bundled agent has a manifest, and no manifest is orphaned", () => {
    const onDisk = readdirSync(DIR).filter((f) => f.endsWith(".yaml")).map((f) => f.replace(/\.yaml$/, "")).sort();
    expect(onDisk).toEqual([...getCatalog()].map((d) => d.id).sort());
  });

  test("the compiled bundle is what the manifests say", () => {
    for (const a of BUNDLED_AGENTS) {
      const raw = YAML.parse(readFileSync(join(DIR, `${a.id}.yaml`), "utf8")) as unknown;
      expect(a.manifest).toEqual(raw);
      expect(a.nodeHalf).toBe(PLUGINS.some((p) => p.def.id === a.id));
    }
    expect(BUNDLED_AGENTS.map((a) => a.id)).toEqual([...getCatalog()].map((d) => d.id));
  });

  test("each one loads with the trust its origin earns, and keeps its spawn behaviour", () => {
    for (const def of getCatalog()) {
      expect(def.id).toBeTruthy();
      expect(def.bin).toBeTruthy();
      const opts: SpawnOptions = {};
      expect(() => spawnArgsFor(def, opts)).not.toThrow();
      expect(spawnLabelFor(def, 1, opts)).toBeTruthy();
      for (const mode of MODES) {
        for (const model of MODELS) {
          const o: SpawnOptions = { ...(mode ? { mode } : {}), ...(model ? { model } : {}) };
          expect(() => spawnArgsFor(def, o)).not.toThrow();
        }
      }
    }
  });
});

describe("manifest validation refuses what it cannot back", () => {
  const base = {
    manifestVersion: AGENT_MANIFEST_VERSION,
    id: "acme", label: "Acme", bin: "acme",
    caps: {
      promptDelivery: "typed", turnSignal: false, resume: "none",
      supervise: "human", blockedDetection: false,
    },
  };
  const bad = (patch: object, msg: RegExp): void => {
    expect(() => defFromManifest({ ...base, ...patch })).toThrow(msg);
  };

  test("a plugin cannot claim a capability only a node half delivers", () => {
    bad({ caps: { ...base.caps, turnSignal: true } }, /turnSignal must be false/);
    bad({ caps: { ...base.caps, resume: "cwd" } }, /resume must be "none"/);
    bad({ caps: { ...base.caps, supervise: "broker" } }, /cannot be "broker"/);
  });

  test("a plugin cannot point its label at an arbitrary executable", () => {
    bad({ bin: "/tmp/evil" }, /bare basename/);
    bad({ bin: "..\\evil.exe" }, /bare basename/);
  });

  test("a plugin cannot squat a built-in id", () => {
    expect(() => defFromManifest({ ...base, id: "claude" }, { reserved: getCatalog().map((d) => d.id) }))
      .toThrow(/reserved/);
  });

  test("a plugin may resume, but only from under the user's home", () => {
    const find = { strategy: "jsonl-header", root: "{home}/.acme/sessions", cwdPath: "cwd", idPath: "id" };
    const ok = defFromManifest({ ...base, caps: { ...base.caps, resume: "cwd" }, session: { resume: { args: ["--resume", "{id}"], find } } });
    expect(ok.session?.resume?.find?.root).toBe("{home}/.acme/sessions");
    for (const root of ["/etc/shadow", "{home}/../../etc", "~/.ssh"]) {
      expect(() => defFromManifest({ ...base, session: { resume: { args: ["--resume", "{id}"], find: { ...find, root } } } }))
        .toThrow(/must be under \{home\}\/|cannot climb out|plain path/);
    }
    // An agent that ships with Hivemind may read where its CLI actually keeps sessions.
    expect(defFromManifest({ ...base, session: { resume: { args: ["--resume", "{id}"], find: { ...find, root: "/var/lib/acme" } } } },
      { trusted: true }).session?.resume?.find?.root).toBe("/var/lib/acme");
  });

  test("a claimed resume must say where the sessions are", () => {
    expect(() => defFromManifest({ ...base, caps: { ...base.caps, resume: "cwd" } }))
      .toThrow(/caps.resume must be "none" unless/);
  });

  test("nobody ships a regex — not a plugin, not us", () => {
    const detect = { default: "idle", rules: [{ when: { re: "(a+)+$" }, then: "working" }] };
    for (const trusted of [false, true]) {
      expect(() => defFromManifest({ ...base, detect }, { trusted })).toThrow(/do not take regexes/);
    }
  });

  test("a sequence cannot be written so that it would backtrack", () => {
    const rules = (when: object) => ({ default: "idle", rules: [{ when, then: "working" }] });
    // An unbounded run followed by something it would have eaten is the only shape that
    // could make this matcher quadratic, so it is refused at load.
    expect(() => defFromManifest({ ...base, detect: rules({ seq: [{ run: "space", min: 0 }, { run: "space", min: 1 }] }) }))
      .toThrow(/would have eaten it/);
    expect(() => defFromManifest({ ...base, detect: rules({ seq: [{ run: "digit", min: 1 }, { upTo: "x" }] }) }))
      .toThrow(/cannot be followed by `upTo`/);
    // The same shape with a bound on the run is fine: it cannot run away.
    expect(defFromManifest({ ...base, detect: rules({ seq: [{ run: "digit", min: 1, max: 4 }, { upTo: "x" }] }) }).detect)
      .toBeDefined();
  });

  test("a listing command is plain tokens, whoever wrote it", () => {
    const list = (args: unknown) => [{ id: "model", label: "Model", flag: "--model", list: { args } }];
    // No shell runs it here, but a Windows .cmd shim does: punctuation would be a second command.
    for (const bad of [["models; rm -rf ~"], ["models && curl x|sh"], ["$(id)"], ["a b"], []]) {
      expect(() => defFromManifest({ ...base, options: list(bad) })).toThrow(/list\.args/);
    }
    // Plain tokens pass for a plugin — what the command actually is, the review names, and
    // auto-install refuses to run one nobody read.
    expect(defFromManifest({ ...base, options: list(["models"]) }).options?.[0]?.list?.args).toEqual(["models"]);
  });

  test("a plugin may wire hooks and a private home — and every one of them is disclosed", () => {
    const wired = {
      ...base,
      caps: { ...base.caps, turnSignal: true },
      launch: { hcp: true },
      hooks: { events: { Stop: { hook: "stop" } }, arg: "--settings" },
      home: { root: "home", dir: ".acme", mirror: "{home}/.acme", env: "ACME_HOME" },
      options: [{ id: "model", label: "Model", flag: "--model", list: { args: ["models"] } }],
    };
    const def = defFromManifest(wired);
    expect(def.caps.turnSignal).toBe(true);
    expect(agentDisclosures(def)).toEqual([
      "runs `acme models` to list model values",
      "links your {home}/.acme into a private copy it points acme at",
      "wires its own hooks to Hivemind's control plane, which can read and send to your tiles",
    ]);
    // Claiming the signal without wiring anything that sends it is still refused.
    expect(() => defFromManifest({ ...wired, launch: undefined, hooks: undefined, home: undefined }))
      .toThrow(/turnSignal must be false/);
    // An agent that only runs its own CLI has nothing to disclose, so it may install unattended.
    expect(agentDisclosures(defFromManifest(base))).toEqual([]);
  });

  test("an id Hivemind has shipped keeps its command, bundled or not", () => {
    // The reservation is the list, not the bundle: gemini stays gemini's name after the day
    // it stops shipping in the box.
    expect(() => defFromManifest({ ...base, id: "gemini", bin: "curl" }))
      .toThrow(/id "gemini" is Hivemind's agent for `gemini`/);
    expect(defFromManifest({ ...base, id: "gemini", bin: "gemini" }).id).toBe("gemini");
    // Every agent that ships today is on the list, so unbundling one cannot open its name.
    for (const a of BUNDLED_AGENTS) expect(RESERVED_AGENTS[a.id]).toBe((a.manifest as { bin: string }).bin);
  });

  test("an install link must be https, and its command one line", () => {
    bad({ install: { url: "javascript:alert(1)" } }, /https link/);
    bad({ install: { url: "http://x.dev" } }, /https link/);
    bad({ install: { url: "https://x.dev", command: "curl x | sh\nrm -rf ~" } }, /one line/);
    expect(defFromManifest({ ...base, install: { url: "https://x.dev/install", command: "npm i -g x" } }).install)
      .toEqual({ url: "https://x.dev/install", command: "npm i -g x" });
  });

  test("a value that looks like a flag is never passed on", () => {
    const def = defFromManifest({ ...base, options: [{ id: "model", label: "Model", flag: "--model" }] });
    expect(spawnArgsFor(def, { model: "--dangerously-skip-permissions" })).toEqual([]);
  });

  test("a plugin cannot inject markup through its icon", () => {
    bad({ icon: { viewBox: "0 0 1 1", shapes: [{ path: { onload: "x" } }] } }, /not allowed/);
    bad({ icon: { viewBox: "0 0 1 1", shapes: [{ script: { d: "x" } }] } as never }, /icon shape must be one of/);
    bad({ icon: { viewBox: "0 0 1 1", attrs: { onLoad: "x" }, shapes: [] } }, /icon.attrs "onLoad" is not allowed/);
    bad({ icon: { viewBox: "0 0 1 1", attrs: { dangerouslySetInnerHTML: "x" }, shapes: [] } }, /is not allowed/);
    const def = defFromManifest({ ...base, icon: { viewBox: "0 0 1 1", shapes: [{ path: { d: '" onload="x' } }] } });
    expect(def.icon.body).not.toContain('onload="x"');
    expect(def.icon.body).toContain("&quot;");
  });


  test("a malformed rule is refused at LOAD, never left to fail at poll time", () => {
    // An unknown node used to become `new RegExp(undefined)`, matching every screen.
    bad({ detect: { default: "idle", rules: [{ when: { bogus: 1 }, then: "working" }] } },
      /unknown expression \["bogus"\]/);
    bad({ detect: { default: "idle", rules: [{ when: { line: [{ nope: 1 }] }, then: "working" }] } },
      /unknown line test/);
    bad({ detect: { default: "idle", rules: [{ when: { helper: "rm -rf" }, then: "working" }] } },
      /helper must be one of/);
    bad({ detect: { default: "idle", rules: [{ when: { line: [{ numBeforeWord: "task", op: "BOGUS", value: 0 }] }, then: "working" }] } },
      /op must be one of/);
    bad({ detect: { default: "idle", rules: [{ when: "hello", then: "working" }] } }, /when must be an object/);
    bad({ detect: { default: "idle", rules: [{ when: { line: [{ startsWithAny: ["-> "] }] }, then: "working" }] } },
      /must be a single character/);
    bad({ detect: { default: "idle", scope: { kind: "nope" }, rules: [] } }, /scope.kind must be/);
    bad({ detect: { default: "idle", rules: [{ when: { contains: "x" }, then: "working", scope: { kind: "tail", n: 0 } }] } },
      /n must be a positive integer/);
  });

  test("a malformed spawn block is refused at LOAD, never left to corrupt argv", () => {
    bad({ spawn: { args: "--x" } }, /spawn.args must be a string array/);
    bad({ options: { mode: "--x" } }, /options must be a list/);
    bad({ options: [{ id: "mode", label: "M", flag: "rm -rf" }] }, /flag must be a flag/);
    bad({ options: [{ id: "mode", label: "M", flag: "--m" }, { id: "mode", label: "N", flag: "--n" }] }, /unique/);
    bad({ options: [{ id: "mode", label: "M", flag: "--m", values: { plan: "--dry-run" } }] }, /values\["plan"\] must be a string array/);
    bad({ icon: { viewBox: "0 0 1 1", shapes: "nope" } }, /icon.shapes must be an array/);
  });

  test("a well-formed manifest still loads and behaves", () => {
    const def = defFromManifest({
      ...base,
      spawn: { args: ["--x"] },
      options: [{ id: "mode", label: "Mode", flag: "--mode", values: { plan: ["-p"] } }, { id: "model", label: "Model", flag: "-m" }],
      detect: { default: "idle", rules: [{ when: { any: [{ contains: "a" }, { line: [{ startsWith: "x" }] }] }, then: "working" }] },
    });
    expect(spawnArgsFor(def, { mode: "plan", model: "z" })).toEqual(["--x", "-p", "-m", "z"]);
    expect(def.detect!("about")).toBe("working");
    expect(def.detect!("zzz")).toBe("idle");
  });

  test("an agent id is one name — an agent stands for one CLI, so there is no scope", () => {
    expect(defFromManifest({ ...base, id: "acme-two" }).id).toBe("acme-two");
    for (const id of ["@dip497/aider", "dip497/aider", "../aider", "Aider"]) bad({ id }, /id must be lowercase/);
  });

  test("an unversioned or misversioned manifest is refused", () => {
    bad({ manifestVersion: 999 }, /manifestVersion must be 1/);
    bad({ id: "Not Valid" }, /id must be lowercase/);
    bad({ caps: { ...base.caps, blockedDetection: undefined } }, /caps.blockedDetection is required/);
  });
});
