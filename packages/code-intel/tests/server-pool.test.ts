import { describe, expect, test } from "bun:test";
import { ServerPool } from "../src/server-pool.js";

/** A server that records being stopped. */
function fakeServers() {
  const stopped: string[] = [];
  const start = (name: string) => () => Promise.resolve({ name, stop: () => { stopped.push(name); } });
  return { stopped, start };
}

describe("the language servers live on a machine", () => {
  test("at most four: a fifth stops the one asked least lately", async () => {
    const { stopped, start } = fakeServers();
    const pool = new ServerPool<{ name: string; stop(): void }>();
    for (const k of ["a", "b", "c", "d"]) await pool.use(k, start(k));
    await pool.use("a", start("a again"));
    await pool.use("e", start("e"));
    await Promise.resolve();
    expect(stopped).toEqual(["b"]);
    expect(pool.keys().sort()).toEqual(["a", "c", "d", "e"]);
    pool.close();
  });

  test("the same server is given back while it is live", async () => {
    const { start } = fakeServers();
    const pool = new ServerPool<{ name: string; stop(): void }>();
    const first = await pool.use("a", start("first"));
    expect(await pool.use("a", start("second"))).toBe(first);
    pool.close();
  });

  test("a server not asked for the idle time is stopped, and one asked meanwhile is kept", async () => {
    const { stopped, start } = fakeServers();
    const pool = new ServerPool<{ name: string; stop(): void }>({ idleMs: 400 });
    await pool.use("quiet", start("quiet"));
    await pool.use("busy", start("busy"));
    for (let i = 0; i < 12; i++) { await Bun.sleep(50); await pool.use("busy", start("busy")); }
    expect(stopped).toEqual(["quiet"]);
    expect(pool.keys()).toEqual(["busy"]);
    pool.close();
  });

  test("a server that fails to start is not kept", async () => {
    const pool = new ServerPool<{ stop(): void }>();
    await pool.use("a", () => Promise.reject(new Error("no such program"))).catch(() => null);
    await Promise.resolve();
    expect(pool.keys()).toEqual([]);
  });
});
