/**
 * The app's end of the sidecar: started on the first question, started again on the next one
 * after it exits. Only lines of JSON pass here; the parsing and the language servers are the
 * sidecar's. Electron-free: the desktop app and `hive host` each say how to start it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { SidecarAsk, SidecarReply } from "./sidecar.js";

/** How to start the sidecar: a program, its arguments, and what to add to its environment. */
export interface SidecarLaunch { file: string; args: string[]; env?: Record<string, string> }

/** The sidecar built next to this code as `code-sidecar.js` (the app's bundle, run as Node by its
 *  own binary), or run from source as `sidecar-main.ts` (bun runs it, as does node under tsx). A
 *  compiled `hive` carries neither and says how it starts it (`setCodeSidecar`). */
export const launchBeside = (): SidecarLaunch => {
  for (const name of ["./code-sidecar.js", "./sidecar-main.ts"]) {
    try {
      const file = fileURLToPath(new URL(name, import.meta.url));
      if (!fs.existsSync(file)) continue;
      return { file: process.execPath, args: [...(name.endsWith(".ts") ? process.execArgv : []), file], env: { ELECTRON_RUN_AS_NODE: "1" } };
    } catch { /* not a file URL */ }
  }
  throw new Error("this build does not say how to start the code sidecar");
};

type Ask = SidecarAsk extends infer A ? A extends unknown ? Omit<A, "id"> : never : never;

export class SidecarClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly waiting = new Map<number, (r: SidecarReply) => void>();
  private buffered = "";

  constructor(private readonly launch: () => SidecarLaunch = launchBeside) {}

  /** The sidecar's reply, or an error reply when it gives none within `within` ms or exits first. */
  ask(question: Ask, within = 30_000): Promise<SidecarReply> {
    const id = this.nextId++;
    let child: ChildProcess;
    try { child = this.started(); } catch (e) { return Promise.resolve({ id, error: (e as Error).message }); }
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle({ id, error: `no answer within ${within} ms` }), within);
      timer.unref?.();
      this.waiting.set(id, (r) => { clearTimeout(timer); resolve(r); });
      child.stdin!.write(JSON.stringify({ ...question, id }) + "\n");
    });
  }

  /** The sidecar's process id while it runs. */
  get pid(): number | null { return this.child?.pid ?? null; }

  close(): void { this.child?.stdin?.end(); }

  private started(): ChildProcess {
    if (this.child) return this.child;
    const { file, args, env } = this.launch();
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...env }, windowsHide: true });
    this.child = child;
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      this.buffered += chunk;
      let nl: number;
      while ((nl = this.buffered.indexOf("\n")) >= 0) {
        const line = this.buffered.slice(0, nl);
        this.buffered = this.buffered.slice(nl + 1);
        try { this.settle(JSON.parse(line) as SidecarReply); } catch { /* not a reply */ }
      }
    });
    const gone = (why: string) => {
      if (this.child !== child) return;
      this.child = null;
      this.buffered = "";
      for (const id of [...this.waiting.keys()]) this.settle({ id, error: why });
    };
    child.on("exit", (code) => gone(`the code sidecar stopped (${code})`));
    child.on("error", (e) => gone(`the code sidecar could not start: ${e.message}`));
    child.stdin!.on("error", () => { /* the exit says why */ });
    return child;
  }

  private settle(r: SidecarReply): void {
    const done = this.waiting.get(r.id);
    if (!done) return;
    this.waiting.delete(r.id);
    done(r);
  }
}
