// `hive host install` (R14): a systemd user unit that runs this `hive`'s `host run`, with what the
// shell that installed it knows (where hive-net is, the data folder), starts again when it stops,
// and stops only the host, so the daemon's terminals and agents outlive a restart; what systemd
// could not do is said with the command that finishes it; `uninstall` takes the unit away. The
// unit goes under this test's own config folder, where no systemd reads it.
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLI, hive } from "./helpers.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-service-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

test.skipIf(process.platform !== "linux")("install writes a user unit that runs this hive's host and leaves the daemon's terminals running; uninstall removes it", () => {
  const hiveNet = path.join(tmp, "bin", "hive-net");
  fs.mkdirSync(path.dirname(hiveNet), { recursive: true });
  fs.writeFileSync(hiveNet, "");
  const env = { XDG_CONFIG_HOME: path.join(tmp, "config"), HIVEMIND_APP_DATA: path.join(tmp, "data"), HIVEMIND_HIVE_NET: hiveNet };
  const unitFile = path.join(tmp, "config", "systemd", "user", "hive-host.service");

  const installed = hive(["host", "install", "--json"], { env });
  expect(installed.code).toBe(0);
  const done = (installed.json as { data: { unit: string; started: boolean; todo: string[] } }).data;
  expect(done.unit).toBe(unitFile);
  const unit = fs.readFileSync(unitFile, "utf8");
  // This hive (the binary, or bun and the source), running the host.
  expect(unit).toMatch(/^ExecStart=.*"host" "run"$/m);
  expect(unit.match(/^ExecStart=.*$/m)![0]).toContain(process.env.HIVE_BIN ?? CLI);
  expect(unit).toContain(`Environment="HIVEMIND_HIVE_NET=${hiveNet}"`);
  expect(unit).toContain(`Environment="HIVEMIND_APP_DATA=${path.join(tmp, "data")}"`);
  expect(unit).toMatch(/^Restart=on-failure$/m);
  expect(unit).toMatch(/^KillMode=process$/m);
  expect(unit).toMatch(/^WantedBy=default.target$/m);
  // No systemd reads this folder: what is left to do is said.
  expect(done.started).toBe(false);
  expect(done.todo.some((t) => t.startsWith("systemctl --user daemon-reload && systemctl --user enable --now hive-host.service"))).toBe(true);

  expect((hive(["host", "uninstall", "--json"], { env }).json as { data: { removed: boolean } }).data.removed).toBe(true);
  expect(fs.existsSync(unitFile)).toBe(false);
  expect((hive(["host", "uninstall", "--json"], { env }).json as { data: { removed: boolean } }).data.removed).toBe(false);
});
