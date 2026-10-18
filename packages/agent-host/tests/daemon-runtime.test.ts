// A daemon started from an AppImage's mount runs from a copy extracted once per version, which
// outlives the mount; a copy of another version is removed once nothing runs from it.
import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { lastingDaemon } from "../src/daemon-runtime.ts";

const linux = process.platform === "linux";
const dir = fs.mkdtempSync("/tmp/hdrt-");
const kids: number[] = [];
afterAll(() => { for (const pid of kids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } fs.rmSync(dir, { recursive: true, force: true }); });

// What `--appimage-extract` does: the AppImage's tree into ./squashfs-root. It counts its runs.
const appImage = path.join(dir, "hivemind.AppImage");
fs.writeFileSync(appImage, [
  "#!/bin/sh",
  `[ "$1" = --appimage-extract ] || exit 2`,
  `echo run >> "${dir}/extractions"`,
  "mkdir -p squashfs-root/resources/app.asar/out/main",
  "cp /bin/sleep squashfs-root/hivemind",
  "echo daemon > squashfs-root/resources/app.asar/out/main/pty-daemon.js",
].join("\n"), { mode: 0o755 });
const mount = "/tmp/.mount_hivemiAbC123";
const runtimes = path.join(dir, "runtime");
const asked = (version: string) => lastingDaemon({
  runtime: `${mount}/hivemind`, script: `${mount}/resources/app.asar/out/main/pty-daemon.js`, appImage, mount, dir: runtimes, version,
});
const extractions = () => (fs.existsSync(path.join(dir, "extractions")) ? fs.readFileSync(path.join(dir, "extractions"), "utf8").trim().split("\n").length : 0);

test.skipIf(!linux)("from an AppImage's mount, the daemon runs from a copy extracted once per version, and copies nothing runs from go", async () => {
  const [runtime, script] = await asked("1.0.0");
  expect(runtime).toBe(path.join(runtimes, "1.0.0", "squashfs-root", "hivemind"));
  expect(fs.readFileSync(script, "utf8").trim()).toBe("daemon");
  expect(extractions()).toBe(1);
  // A daemon running from that copy.
  const daemon = spawn(runtime, ["60"], { stdio: "ignore" });
  kids.push(daemon.pid!);
  await new Promise((r) => setTimeout(r, 300));

  await asked("1.0.1");
  await asked("1.0.1");
  expect(extractions()).toBe(2);
  expect(fs.existsSync(runtime)).toBe(true);

  daemon.kill("SIGKILL");
  await new Promise((r) => daemon.once("exit", r));
  await asked("1.0.2");
  expect(fs.readdirSync(runtimes).sort()).toEqual(["1.0.2"]);
});

test("a daemon not started from an AppImage's mount runs from where it is", async () => {
  expect(await lastingDaemon({ runtime: "/opt/hivemind/hivemind", script: "/opt/hivemind/resources/app.asar/out/main/pty-daemon.js", dir: runtimes, version: "1.0.0" }))
    .toEqual(["/opt/hivemind/hivemind", "/opt/hivemind/resources/app.asar/out/main/pty-daemon.js"]);
});
