/** node-pty's native addon driven directly: its JS stream layer kills the shell on first write under bun. Unix only. */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { StringDecoder } from "node:string_decoder";

interface NativeTerm { fd: number; pid: number; pty: string }
interface NativePty {
  fork(file: string, args: string[], env: string[], cwd: string, cols: number, rows: number, uid: number, gid: number, utf8: boolean, helperPath: string, onExit: (code: number, signal: number) => void): NativeTerm;
  resize(fd: number, cols: number, rows: number, xPixel: number, yPixel: number): void;
}

export interface BunPtyOptions {
  cwd: string;
  cols: number;
  rows: number;
  name?: string;
  env: Record<string, string>;
}

/** The node-pty IPty subset the daemon's factory uses. */
export interface BunPty {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal: number }) => void): void;
}

/** Report exit anyway if the read side never drains (e.g. while paused). */
const DRAIN_TIMEOUT_MS = 200;

/** Older bun cannot read a pty through `Bun.file(fd).stream()`. */
export const MIN_BUN = "1.2.10";

type BunGlobal = { version: string; file(fd: number): { stream(): ReadableStream<Uint8Array> } };
function bunRuntime(): BunGlobal {
  const b = (globalThis as { Bun?: BunGlobal }).Bun;
  if (!b) throw new Error("bun-pty requires the bun runtime");
  const [x, y, z] = b.version.split(".").map((n) => parseInt(n, 10));
  const [mx, my, mz] = MIN_BUN.split(".").map((n) => parseInt(n, 10));
  if (x! < mx! || (x === mx && (y! < my! || (y === my && z! < mz!)))) {
    throw new Error(`bun ${b.version} cannot read a pty (needs ≥ ${MIN_BUN}) — rebuild hive with a newer bun`);
  }
  return b;
}

let loaded: { native: NativePty; dir: string } | undefined;

/** Embedded by the `hive` build (`__hivePtyNative`), else resolved next to @lydell/node-pty. */
function loadNative(): { native: NativePty; dir: string } {
  if (loaded) return loaded;
  const embedded = (globalThis as { __hivePtyNative?: { native: NativePty; dir: string } }).__hivePtyNative;
  if (embedded) return (loaded = embedded);
  const req = createRequire(import.meta.url);
  const plat = `${process.platform}-${process.arch}`;
  const platMain = createRequire(req.resolve("@lydell/node-pty")).resolve(`@lydell/node-pty-${plat}`);
  const dir = path.join(path.dirname(platMain), "..", "prebuilds", plat);
  return (loaded = { native: req(path.join(dir, "pty.node")) as NativePty, dir });
}

export function spawn(file: string, args: string[] | string, opts: BunPtyOptions): BunPty {
  // The daemon's shared spawn type carries node-pty's Windows string form; this
  // unix-only driver has no command-line parser to hand it to.
  if (typeof args === "string") throw new Error("bun-pty: a raw command line is not supported (unix only)");
  const bun = bunRuntime(); // before fork: an unsupported bun must not leak a child
  const { native, dir } = loadNative();
  const env: Record<string, string> = { ...opts.env, PWD: opts.cwd, TERM: opts.name ?? opts.env.TERM ?? "xterm-256color" };
  const envList = Object.entries(env).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`);

  const dataCbs: ((d: string) => void)[] = [];
  const exitCbs: ((e: { exitCode: number; signal: number }) => void)[] = [];
  let exitInfo: { exitCode: number; signal: number } | null = null;
  let readDone = false;
  let exitEmitted = false;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;

  const emitExit = () => {
    if (exitEmitted || !exitInfo) return;
    exitEmitted = true;
    if (drainTimer) clearTimeout(drainTimer);
    try { fs.closeSync(term.fd); } catch { /* already closed */ }
    for (const cb of exitCbs) cb(exitInfo);
  };

  const term = native.fork(file, args, envList, opts.cwd, opts.cols, opts.rows, -1, -1, true, path.join(dir, "spawn-helper"), (code, signal) => {
    exitInfo = { exitCode: code, signal };
    if (readDone) emitExit();
    else drainTimer = setTimeout(emitExit, DRAIN_TIMEOUT_MS);
  });

  // Pausing stops pulling, so the kernel buffer fills and the child blocks.
  const decoder = new StringDecoder("utf8");
  const reader = bun.file(term.fd).stream().getReader();
  let paused = false;
  let pumping = false;
  // Bytes from a read already in flight when pause() lands; emitted on resume.
  let held = "";
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (!paused) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.write(Buffer.from(value));
        if (!text) continue;
        if (paused) { held += text; break; }
        for (const cb of dataCbs) cb(text);
      }
      if (paused) return;
    } catch {
      /* EIO once the child side closes — the normal end of a pty */
    } finally {
      pumping = false;
    }
    readDone = true;
    const tail = decoder.end();
    if (tail) for (const cb of dataCbs) cb(tail);
    if (exitInfo) emitExit();
  };
  queueMicrotask(pump); // let the caller register onData first

  // Write what the kernel takes; retry on EAGAIN after yielding.
  const queue: { buf: Buffer; off: number }[] = [];
  const drain = () => {
    const task = queue[0];
    if (!task || exitEmitted) { queue.length = 0; return; }
    fs.write(term.fd, task.buf, task.off, task.buf.length - task.off, null, (err, n) => {
      if (err) {
        if ((err as NodeJS.ErrnoException).code === "EAGAIN") { setImmediate(drain); return; }
        queue.length = 0; // child gone
        return;
      }
      task.off += n;
      if (task.off >= task.buf.length) queue.shift();
      drain();
    });
  };

  return {
    get pid() { return term.pid; },
    write(data) {
      const buf = Buffer.from(data, "utf8");
      if (!buf.length || exitEmitted) return;
      queue.push({ buf, off: 0 });
      if (queue.length === 1) drain();
    },
    resize(cols, rows) {
      if (!(cols > 0 && rows > 0 && Number.isFinite(cols) && Number.isFinite(rows))) throw new Error("resizing must be done using positive cols and rows");
      if (!exitEmitted) native.resize(term.fd, cols, rows, 0, 0);
    },
    kill(signal) {
      try { process.kill(term.pid, (signal ?? "SIGHUP") as NodeJS.Signals); } catch { /* already gone */ }
    },
    pause() { paused = true; },
    resume() {
      if (!paused) return;
      paused = false;
      if (held) { const h = held; held = ""; for (const cb of dataCbs) cb(h); }
      void pump();
    },
    onData(cb) { dataCbs.push(cb); },
    onExit(cb) { exitCbs.push(cb); },
  };
}
