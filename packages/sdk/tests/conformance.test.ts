/** conformance/drive.json against the TypeScript client: a host that plays each case's lines over
 *  a real local socket, and the client as a program uses it. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { ApiError, connect, driveSocketPath, type HiveClient } from "../src/index.js";

type Step = Record<string, unknown>;
interface Case { name: string; connect: { token: string; workspace?: string }; steps: Step[] }
const drive = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../../../conformance/drive.json"), "utf8")) as {
  places: Array<{ name: string; platform: NodeJS.Platform; env: Record<string, string>; socket: string }>;
  cases: Case[];
};

const unix = process.platform !== "win32";
// sun_path is ~108 bytes; os.tmpdir() can be deep, /tmp is not.
const dir = unix ? fs.mkdtempSync("/tmp/hivemind-api-") : "";
const WAIT_MS = 3000;

beforeAll(() => { delete process.env.HIVE_WORKSPACE; });
afterAll(() => { if (unix) fs.rmSync(dir, { recursive: true, force: true }); });

/** The host's end of one connection: the lines it reads, in order, and the end when it comes. */
class HostEnd {
  private lines: string[] = [];
  private ended = false;
  private wake: (() => void) | null = null;
  private buf = "";
  constructor(readonly socket: net.Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) { this.lines.push(this.buf.slice(0, nl)); this.buf = this.buf.slice(nl + 1); }
      this.wake?.();
    });
    socket.on("end", () => { this.ended = true; this.wake?.(); });
    socket.on("close", () => { this.ended = true; this.wake?.(); });
  }
  async next(): Promise<string | null> {
    const until = Date.now() + WAIT_MS;
    while (this.lines.length === 0 && !this.ended && Date.now() < until) {
      await new Promise<void>((r) => { this.wake = r; setTimeout(r, 50); });
    }
    return this.lines.shift() ?? null;
  }
}

const settle = <T>(p: Promise<T>): Promise<{ value?: T; error?: unknown }> => p.then((value) => ({ value }), (error: unknown) => ({ error }));
const within = <T>(p: Promise<T>, what: string): Promise<T> =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no ${what} within ${WAIT_MS} ms`)), WAIT_MS))]);

async function play(c: Case, sock: string): Promise<void> {
  const ends: HostEnd[] = [];
  const server = net.createServer((s) => ends.push(new HostEnd(s)));
  await new Promise<void>((r) => server.listen(sock, r));
  const ids = new Map<string, number>();
  const calls = new Map<string, Promise<{ value?: unknown; error?: unknown }>>();
  const heard = new Map<string, unknown[][]>();
  const connecting = settle(connect({ socket: sock, token: c.connect.token, ...(c.connect.workspace ? { workspace: c.connect.workspace } : {}) }));
  let client: HiveClient | undefined;
  const host = async (): Promise<HostEnd> => {
    for (const until = Date.now() + WAIT_MS; !ends[0] && Date.now() < until;) await new Promise((r) => setTimeout(r, 10));
    if (!ends[0]) throw new Error("the client never connected");
    return ends[0];
  };
  const withIds = (v: unknown): unknown => {
    const m = v as { id?: unknown };
    return m && typeof m === "object" && !Array.isArray(m) && typeof m.id === "string" ? { ...m, id: ids.get(m.id) } : v;
  };
  try {
    for (const step of c.steps) {
      const [kind, arg] = Object.entries(step)[0]! as [string, any];
      switch (kind) {
        case "host_reads": {
          const line = await (await host()).next();
          expect(line).not.toBeNull();
          const got = JSON.parse(line!) as Record<string, unknown>;
          if (typeof arg.id === "string") {
            expect(typeof got.id).toBe("number");
            ids.set(arg.id, got.id as number);
          }
          expect(got).toEqual(withIds(arg) as Record<string, unknown>);
          break;
        }
        case "host_sends": (await host()).socket.write(`${JSON.stringify(withIds(arg))}\n`); break;
        case "host_sends_raw":
          (await host()).socket.write(String(arg).replace(/<id:(\w+)>/g, (_, l: string) => String(ids.get(l))));
          await new Promise((r) => setTimeout(r, 50));
          break;
        case "host_closes": (await host()).socket.destroy(); break;
        case "host_sees_end": expect(await (await host()).next()).toBeNull(); break;
        case "connected": {
          const r = await within(connecting, "hello");
          expect(r.error).toBeUndefined();
          client = r.value!;
          expect({ as: client.as, api: client.api }).toEqual(arg);
          break;
        }
        case "refused": {
          const r = await within(connecting, "refusal");
          expect(r.error).toBeInstanceOf(ApiError);
          expect((r.error as ApiError).code).toBe(arg.code);
          if (arg.message !== undefined) expect((r.error as ApiError).message).toBe(arg.message);
          break;
        }
        case "call": calls.set(arg.label, settle(client!.call(arg.method, arg.params, arg.timeoutMs === undefined ? {} : { timeoutMs: arg.timeoutMs }))); break;
        case "answered": {
          const r = await within(calls.get(arg.label)!, `answer to ${arg.label}`);
          expect(r.error).toBeUndefined();
          expect(r.value).toEqual(arg.result);
          break;
        }
        case "failed": {
          const r = await within(calls.get(arg.label)!, `failure of ${arg.label}`);
          expect(r.error).toBeInstanceOf(ApiError);
          expect((r.error as ApiError).code).toBe(arg.code);
          if (arg.message !== undefined) expect((r.error as ApiError).message).toBe(arg.message);
          break;
        }
        case "notice": client!.notice(arg.method, arg.params); break;
        case "listen": {
          const got: unknown[][] = [];
          heard.set(arg, got);
          client!.on(arg, (...params: unknown[]) => { got.push(params); });
          break;
        }
        case "heard": {
          const got = heard.get(arg.event)!;
          for (const until = Date.now() + WAIT_MS; got.length < arg.params.length && Date.now() < until;) await new Promise((r) => setTimeout(r, 10));
          expect(got).toEqual(arg.params);
          break;
        }
        case "close": client!.close(); break;
        case "closed": await within(client!.closed, "close"); break;
        default: throw new Error(`conformance/drive.json: no step ${kind}`);
      }
    }
  } finally {
    client?.close();
    for (const e of ends) e.socket.destroy();
    await new Promise((r) => server.close(r));
  }
}

describe("conformance/drive.json: where the drive socket is", () => {
  for (const p of drive.places) {
    test(p.name, () => {
      expect(driveSocketPath({ platform: p.platform, env: p.env })).toBe(p.socket);
    });
  }
});

describe.skipIf(!unix)("conformance/drive.json: a program on the drive socket", () => {
  drive.cases.forEach((c, i) => {
    test(c.name, () => play(c, path.join(dir, `${i}.sock`)));
  });
});
