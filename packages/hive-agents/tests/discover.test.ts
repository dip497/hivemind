import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPresence, discoverOptions, verifyAgent } from "../src/discover.js";
import type { AgentProviderDef } from "../src/types.js";

const posix = process.platform !== "win32";

function fakeAgent(bin: string, script: string): void {
  const dir = mkdtempSync(join(tmpdir(), "hm-discover-"));
  writeFileSync(join(dir, bin), `#!/bin/sh\n${script}\n`);
  chmodSync(join(dir, bin), 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
}

const def = (bin: string): AgentProviderDef => ({
  id: bin, label: bin, bin, enabled: true, icon: { viewBox: "", body: "" },
  caps: { promptDelivery: "argv", turnSignal: false, resume: "none", supervise: "none", blockedDetection: false },
  options: [
    { id: "mode", label: "Mode", flag: "--mode" },
    { id: "model", label: "Model", flag: "--model", list: { args: ["models"] } },
  ],
});

test.skipIf(!posix)("values come from the CLI: --help for one flag, a listing command for another", async () => {
  fakeAgent("hm-fake-a", `
case "$1" in
  --version) echo '1.2.3';;
  --help) echo '  --mode <m>   Mode (choices: "plan", "ask")'; echo '  --model <m>  Model';;
  models) printf 'big\\nsmall\\n';;
esac`);
  const r = await discoverOptions(def("hm-fake-a"));
  expect(r.mode).toEqual({ values: ["plan", "ask"], from: "help" });
  expect(r.model).toEqual({ values: ["big", "small"], from: "list" });
});

test.skipIf(!posix)("a failing listing command falls back to --help and says why", async () => {
  fakeAgent("hm-fake-b", `
[ "$1" = --version ] && { echo 'agent 0.9.0'; exit 0; }
[ "$1" = models ] && { echo 'Error: Authentication required' >&2; exit 1; }
echo '  --mode <m>   Mode (choices: "plan")'`);
  const r = await discoverOptions(def("hm-fake-b"));
  expect(r.model).toEqual({ values: [], from: null, error: "hm-fake-b models failed" });
  expect(r.mode!.values).toEqual(["plan"]);
});

test("a CLI that is not installed yields no values, with the reason", async () => {
  const r = await discoverOptions(def("hm-definitely-not-installed"));
  expect(r.mode).toEqual({ values: [], from: null, error: "hm-definitely-not-installed is not installed" });
});

test.skipIf(!posix)("a same-named program that does not answer --version is never asked for --help", async () => {
  fakeAgent("hm-fake-gui", `
[ "$1" = --help ] && touch "$HOME/.hm-fake-gui-help-ran"
echo 'starting express'; echo 'opening window'`);
  process.env.HOME = mkdtempSync(join(tmpdir(), "hm-home-"));
  expect(agentPresence(def("hm-fake-gui")).mismatch).toBeUndefined(); // nothing run yet
  const v = await verifyAgent(def("hm-fake-gui"));
  expect(agentPresence(def("hm-fake-gui")).mismatch).toContain("did not print a version"); // now known
  expect(v.version).toBeUndefined();
  expect(v.mismatch).toContain("did not print a version");
  const r = await discoverOptions(def("hm-fake-gui"));
  expect(r.mode!.values).toEqual([]);
  expect(existsSync(join(process.env.HOME, ".hm-fake-gui-help-ran"))).toBe(false);
});

test.skipIf(!posix)("a probe that hangs is killed with everything it started", async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), "hm-pid-")), "bg");
  process.env.HM_PIDFILE = pidFile;
  fakeAgent("hm-fake-hang", `sleep 30 & echo $! > "$HM_PIDFILE"; sleep 30`);
  const t0 = Date.now();
  const v = await verifyAgent(def("hm-fake-hang"));
  expect(v.mismatch).toContain("did not finish");
  expect(Date.now() - t0).toBeLessThan(7000);
  await new Promise((r) => setTimeout(r, 200));
  expect(existsSync(`/proc/${readFileSync(pidFile, "utf8").trim()}`)).toBe(false);
}, 10000);
