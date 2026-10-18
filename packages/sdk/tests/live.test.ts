/** The client against a real `hive host`, started from source with a data folder of its own: a
 *  grant's token is let in at its role, a method the role lacks is FORBIDDEN, and taking the grant
 *  back closes the connection. */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ApiError, connect } from "../src/index.js";

setDefaultTimeout(60_000);
const unix = process.platform !== "win32";
const CLI = path.resolve(import.meta.dir, "../../../apps/cli/src/index.ts");
// sun_path is ~108 bytes; os.tmpdir() can be deep, /tmp is not.
const dir = unix ? fs.mkdtempSync("/tmp/hivemind-api-live-") : "";
const workspace = path.join(dir, "work");
const data = path.join(dir, "data");
// Its own home, so no hive-net or settings of this machine's are found, and no tile's sockets.
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: path.join(dir, "home"),
  HIVEMIND_APP_DATA: data,
  HIVEMIND_PTY_SOCK: path.join(dir, "pty.sock"),
  HIVEMIND_SHELL_ENV: "0",
};
let host: ChildProcess | undefined;

const hive = (...args: string[]) => {
  const r = spawnSync("bun", [CLI, ...args, "--json"], { env, encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) throw new Error(`hive ${args.join(" ")}: ${r.stdout}${r.stderr}`);
  return (JSON.parse(r.stdout) as { data: Record<string, unknown> }).data;
};

beforeAll(async () => {
  if (!unix) return;
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(env.HOME!, { recursive: true });
  host = spawn("bun", [CLI, "host", "run"], { env, stdio: "ignore" });
  for (const until = Date.now() + 30_000; !fs.existsSync(path.join(data, "drive.sock")) && Date.now() < until;) await new Promise((r) => setTimeout(r, 100));
  hive("host", "add", workspace);
});

afterAll(() => {
  if (!unix) return;
  if (host?.pid) process.kill(host.pid);
  // The terminals' daemon `hive host` started outlives it by design: stop it by its socket.
  spawnSync("bun", [CLI, "daemon", "stop"], { env, timeout: 30_000 });
  fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!unix)("a real hive host", () => {
  test("a grant's token drives its workspace at its role, until the grant is taken back", async () => {
    const made = hive("grant", "create", "dashboard", "-w", workspace, "--role", "view") as { token: string; grant: { id: string } };
    const client = await connect({ token: made.token, socket: path.join(data, "drive.sock") });
    try {
      expect(client.as).toEqual({ client: "dashboard", role: "view", workspace: fs.realpathSync(workspace) });
      expect(await client.agents.list()).toEqual({ seq: 0, agents: [] });

      const refused = await client.agents.start({ program: "claude", prompt: "Run the tests" }).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(ApiError);
      expect((refused as ApiError).code).toBe("FORBIDDEN");

      hive("grant", "revoke", made.grant.id);
      await Promise.race([client.closed, new Promise((_, reject) => setTimeout(() => reject(new Error("still open after the revoke")), 5000))]);
      const after = await client.agents.list().catch((e: unknown) => e);
      expect((after as ApiError).code).toBe("UNAVAILABLE");
    } finally {
      client.close();
    }
  });

  test("a token that is no grant is refused before anything is called", async () => {
    const refused = await connect({ token: "hgr_nothing", workspace, socket: path.join(data, "drive.sock") }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).code).toBe("FORBIDDEN");
  });
});
