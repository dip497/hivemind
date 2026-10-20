// A login shell too slow at startup (many agents booting at once) must not leave every later start
// without the person's PATH and keys for the rest of the session.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyShellEnvToProcess } from "@hivemind/agent-host/shell-env";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hse-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("a login shell that answers late still gives its environment, and the slow one is not left running", { timeout: 30_000 }, async () => {
  const shell = path.join(dir, "slow-shell");
  const first = path.join(dir, "first-pid");
  // Slow the first time it is asked, quick after: as a shell is while the machine is busy.
  fs.writeFileSync(shell, `#!/bin/sh
if [ ! -e ${first} ]; then echo $$ > ${first}; exec sleep 30; fi
printf '__HIVE_ENV_BEGIN__'; HIVE_FROM_LOGIN_SHELL=yes env -0; printf '__HIVE_ENV_END__'
`, { mode: 0o755 });
  delete process.env.HIVEMIND_SHELL_ENV;
  delete process.env.HIVE_FROM_LOGIN_SHELL;
  process.env.SHELL = shell;

  await applyShellEnvToProcess();
  const slow = Number(fs.readFileSync(first, "utf8"));
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let t = 0; t < 3000 && alive(slow); t += 50) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(slow), false, "the shell that took too long is stopped");
  for (let t = 0; t < 5000 && process.env.HIVE_FROM_LOGIN_SHELL !== "yes"; t += 50) await new Promise((r) => setTimeout(r, 50));
  assert.equal(process.env.HIVE_FROM_LOGIN_SHELL, "yes");
});
