/**
 * One language server, spoken to over its stdin and stdout (JSON-RPC with `Content-Length`
 * headers). It runs as its own process under the sidecar, never inside the app. Positions cross
 * here only: the server's are 0-based lines and UTF-16 columns, ours 1-based lines and the same
 * columns (a JavaScript string's index is UTF-16).
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { languageOf, type CodeLocation, type Hover, type LanguageId, type Place, type Span } from "./contract.js";
import type { Stoppable } from "./server-pool.js";

/** How to start a language server. */
export interface ServerCommand {
  /** Which server, said in answers: `typescript`, `rust-analyzer`, … */
  id: string;
  file: string;
  args: string[];
}

interface LspPosition { line: number; character: number }
interface LspRange { start: LspPosition; end: LspPosition }
interface LspLocation { uri: string; range: LspRange }
interface LspLocationLink { targetUri: string; targetSelectionRange: LspRange }

const LANGUAGE_IDS: Record<LanguageId, string> = {
  typescript: "typescript", tsx: "typescriptreact", javascript: "javascript", python: "python", rust: "rust", go: "go", java: "java",
};
/** How long a question may take before it counts as no answer. */
const ANSWER_MS = 30_000;
/** A server not answering `initialize` in this long is taken as not starting. */
const START_MS = 60_000;

const toLsp = (p: Place): LspPosition => ({ line: p.line - 1, character: p.col });
const fromLsp = (p: LspPosition): Place => ({ line: p.line + 1, col: p.character });
const spanOf = (r: LspRange): Span => ({ start: fromLsp(r.start), end: fromLsp(r.end) });

export class LanguageServer implements Stoppable {
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  /** The version and text each open file was last sent with. */
  private readonly opened = new Map<string, { version: number; text: string }>();
  private buffer: Buffer = Buffer.alloc(0);
  private exited = false;

  private constructor(readonly command: ServerCommand, readonly root: string, private readonly child: ChildProcess, private readonly onExit: (s: LanguageServer) => void) {
    child.stdout!.on("data", (chunk: Buffer) => this.read(chunk));
    child.stderr!.on("data", () => { /* servers log freely; nothing here needs it */ });
    child.on("exit", () => this.gone(new Error(`${command.id} stopped`)));
    child.on("error", (e) => this.gone(e));
    child.stdin!.on("error", () => { /* the exit above says why */ });
  }

  get pid(): number | undefined { return this.child.pid; }

  /** What its answers cover when that is less than the workspace; unset when it is all of it. */
  partial?: string;

  /** Open these files so the server loads the projects they are in. */
  async openAll(files: string[]): Promise<void> {
    for (const f of files) await this.sync(f).catch(() => { /* gone since it was listed */ });
  }

  /** Start the server on `root` and wait until it has said what it can do. */
  static async start(command: ServerCommand, root: string, onExit: (s: LanguageServer) => void = () => {}): Promise<LanguageServer> {
    const child = spawn(command.file, command.args, { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const server = new LanguageServer(command, root, child, onExit);
    try {
      await server.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(root).href,
        workspaceFolders: [{ uri: pathToFileURL(root).href, name: path.basename(root) }],
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          textDocument: {
            synchronization: { dynamicRegistration: false },
            definition: { linkSupport: true },
            references: {},
            hover: { contentFormat: ["markdown", "plaintext"] },
          },
          workspace: { workspaceFolders: true, configuration: true },
        },
      }, START_MS);
      server.notify("initialized", {});
      return server;
    } catch (e) {
      server.stop();
      throw e;
    }
  }

  async definition(file: string, at: Place, text?: string): Promise<CodeLocation[]> {
    await this.sync(file, text);
    return this.locations(await this.request("textDocument/definition", { textDocument: { uri: pathToFileURL(file).href }, position: toLsp(at) }));
  }

  async references(file: string, at: Place, text?: string): Promise<CodeLocation[]> {
    await this.sync(file, text);
    return this.locations(await this.request("textDocument/references", {
      textDocument: { uri: pathToFileURL(file).href }, position: toLsp(at), context: { includeDeclaration: true },
    }));
  }

  async hover(file: string, at: Place, text?: string): Promise<Hover | null> {
    await this.sync(file, text);
    const h = await this.request("textDocument/hover", { textDocument: { uri: pathToFileURL(file).href }, position: toLsp(at) }) as
      { contents: unknown; range?: LspRange } | null;
    if (!h) return null;
    const words = markdownOf(h.contents).trim();
    return words ? { text: words, ...(h.range ? { span: spanOf(h.range) } : {}) } : null;
  }

  stop(): void {
    if (this.exited) return;
    this.request("shutdown", null, 1000).catch(() => null).finally(() => {
      this.notify("exit", null);
      setTimeout(() => { if (!this.exited) this.child.kill("SIGKILL"); }, 500).unref();
    });
  }

  /** The server sees the file as the editor has it (`text`) or as it is on disk. */
  private async sync(file: string, text?: string): Promise<void> {
    const now = text ?? await fs.readFile(file, "utf8");
    const was = this.opened.get(file);
    const uri = pathToFileURL(file).href;
    if (!was) {
      this.opened.set(file, { version: 1, text: now });
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId: LANGUAGE_IDS[languageOf(file) ?? "typescript"], version: 1, text: now } });
    } else if (was.text !== now) {
      const version = was.version + 1;
      this.opened.set(file, { version, text: now });
      this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text: now }] });
    }
  }

  private async locations(raw: unknown): Promise<CodeLocation[]> {
    const list = (raw == null ? [] : Array.isArray(raw) ? raw : [raw]) as (LspLocation | LspLocationLink)[];
    const places = list.map((l) => "targetUri" in l ? { uri: l.targetUri, range: l.targetSelectionRange } : l).filter((l) => l.uri.startsWith("file:"));
    const lines = new Map<string, Promise<string[] | null>>();
    return Promise.all(places.map(async (l) => {
      const abs = fileURLToPath(l.uri);
      let read = lines.get(abs);
      if (!read) lines.set(abs, (read = fs.readFile(abs, "utf8").then((t) => t.split("\n"), () => null)));
      const line = (await read)?.[l.range.start.line];
      const rel = path.relative(this.root, abs);
      return {
        file: rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : abs,
        span: spanOf(l.range),
        ...(line !== undefined ? { text: line.replace(/\r$/, "").slice(0, 400) } : {}),
      };
    }));
  }

  request(method: string, params: unknown, within = ANSWER_MS): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error(`${this.command.id} is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`${this.command.id} did not answer ${method} within ${within} ms`)); }, within);
      timer.unref?.();
      this.waiting.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.exited) this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.child.stdin!.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
  }

  private read(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const length = Number(/Content-Length: *(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString("ascii"))?.[1]);
      if (!Number.isFinite(length)) { this.buffer = this.buffer.subarray(headerEnd + 4); continue; }
      if (this.buffer.length < headerEnd + 4 + length) return;
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      let message: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
      try { message = JSON.parse(body); } catch { continue; }
      if (message.method !== undefined) this.answerServer(message as { id?: number | string; method: string; params?: unknown });
      else if (typeof message.id === "number") this.settle(message.id, message.error ? new Error(message.error.message) : null, message.result);
    }
  }

  /** What a server asks of its client: settings (none), progress and registrations (accepted). */
  private answerServer(m: { id?: number | string; method: string; params?: unknown }): void {
    if (m.id === undefined) return;
    const items = (m.params as { items?: unknown[] } | undefined)?.items;
    const result = m.method === "workspace/configuration" ? (items ?? []).map(() => null) : null;
    this.send({ jsonrpc: "2.0", id: m.id, result });
  }

  private settle(id: number, error: Error | null, result: unknown): void {
    const w = this.waiting.get(id);
    if (!w) return;
    this.waiting.delete(id);
    clearTimeout(w.timer);
    if (error) w.reject(error); else w.resolve(result);
  }

  private gone(e: Error): void {
    if (this.exited) return;
    this.exited = true;
    for (const id of [...this.waiting.keys()]) this.settle(id, e, null);
    this.onExit(this);
  }
}

/** A hover's contents as markdown, whichever of the three shapes the server sent. */
function markdownOf(contents: unknown): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(markdownOf).filter(Boolean).join("\n\n");
  if (contents && typeof contents === "object") {
    const c = contents as { kind?: string; language?: string; value?: string };
    if (c.language !== undefined) return "```" + c.language + "\n" + (c.value ?? "") + "\n```";
    return c.value ?? "";
  }
  return "";
}
