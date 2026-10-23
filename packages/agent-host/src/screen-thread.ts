/** The daemon's side of its screen worker (screen-worker.ts): starts it, asks it for screens and
 *  rows, and starts it again when it dies. */
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { FromScreens, ToScreens } from "./screen-messages.js";
import type { Viewport } from "./pty-protocol.js";

/** Built next to this code as .js (the app's bundle, the compiled `hive`), or run from source as .ts. */
function workerFile(): URL {
  for (const name of ["./screen-worker.js", "./screen-worker.ts"]) {
    const url = new URL(name, import.meta.url);
    try { if (fs.existsSync(fileURLToPath(url))) return url; } catch { /* not a file URL */ }
  }
  return new URL("./screen-worker.js", import.meta.url);
}

/** `modes`: what a client's terminal is told after the screen, which the screen cannot say: the
 *  mouse encoding and the kitty keyboard flags its program asked for. */
export interface Shot { text: string | null; at: number; modes: string }

/** A worker that dies within this long of starting waits longer before the next start. */
const SETTLED_MS = 60_000;
const MAX_WAIT_MS = 60_000;
/** A request the worker has not answered in this long is answered "no screen": a hung worker must
 *  not hang a shutdown's last save or the status reads. */
const ANSWER_MS = 30_000;

export class ScreenThread {
  private worker?: Worker;
  private startedAt = 0;
  private wait = 0;
  /** Set while a dead worker waits to be started again: what is sent meanwhile is dropped. */
  private restarting?: ReturnType<typeof setTimeout>;
  private nextReq = 1;
  private waiting = new Map<number, (m: FromScreens | null) => void>();

  constructor(private readonly on: {
    parsed: (id: string, epoch: string, at: number) => void;
    paste: (id: string, epoch: string, on: boolean) => void;
    title: (id: string, epoch: string, title: string) => void;
    /** The worker died: what waits for it must not. */
    stopped: () => void;
    /** A new worker holds no terminals: open every live session again. */
    restarted: () => void;
  }) {
    // Started now, not at the first screen: a worker takes a while to load.
    this.start();
  }

  /** A worker is there to take output; false while a dead one waits to be started again. */
  get running(): boolean {
    return !this.restarting;
  }

  send(m: ToScreens): void {
    if (this.restarting) return;
    this.start().postMessage(m);
  }

  screen(id: string, epoch: string, lines: number): Promise<Shot> {
    return this.ask((req) => ({ t: "screen", req, id, epoch, lines })).then((m) =>
      m?.t === "screen" ? { text: m.text, at: m.at, modes: m.modes } : { text: null, at: 0, modes: "" });
  }

  /** Null when the worker gave no answer: the rows are unknown, not empty. */
  rows(ids: string[]): Promise<Map<string, Viewport> | null> {
    return this.ask((req) => ({ t: "rows", req, ids })).then((m) => (m?.t === "rows" ? new Map(m.rows) : null));
  }

  private ask(build: (req: number) => ToScreens): Promise<FromScreens | null> {
    if (this.restarting) return Promise.resolve(null);
    const req = this.nextReq++;
    const worker = this.start();
    return new Promise((resolve) => {
      const late = setTimeout(() => this.answer(req, null), ANSWER_MS);
      late.unref?.();
      this.waiting.set(req, (m) => { clearTimeout(late); resolve(m); });
      worker.ref();
      worker.postMessage(build(req));
    });
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(workerFile());
    this.worker = worker;
    this.startedAt = Date.now();
    worker.on("message", (m: FromScreens) => {
      switch (m.t) {
        case "screen":
        case "rows": this.answer(m.req, m); break;
        case "parsed": for (const [id, epoch, at] of m.at) this.on.parsed(id, epoch, at); break;
        case "paste": this.on.paste(m.id, m.epoch, m.on); break;
        case "title": this.on.title(m.id, m.epoch, m.title); break;
      }
    });
    worker.on("error", (e) => console.error("[pty-daemon] screen worker failed:", e));
    worker.on("exit", (code) => { if (this.worker === worker) this.died(code); });
    // After the listeners: adding one refs the worker's port again.
    worker.unref();
    return worker;
  }

  private answer(req: number, m: FromScreens | null): void {
    const resolve = this.waiting.get(req);
    if (!resolve) return;
    this.waiting.delete(req);
    if (this.waiting.size === 0) this.worker?.unref();
    resolve(m);
  }

  private died(code: number): void {
    this.worker = undefined;
    for (const req of [...this.waiting.keys()]) this.answer(req, null);
    this.wait = Date.now() - this.startedAt < SETTLED_MS ? Math.min(Math.max(1000, this.wait * 2), MAX_WAIT_MS) : 0;
    console.error(`[pty-daemon] screen worker exited (${code}); starting it again in ${this.wait} ms`);
    this.restarting = setTimeout(() => {
      this.restarting = undefined;
      this.on.restarted();
    }, this.wait);
    this.restarting.unref?.();
    this.on.stopped();
  }
}
