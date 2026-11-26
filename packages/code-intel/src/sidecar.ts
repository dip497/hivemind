/**
 * The sidecar: one process per machine beside the app (never inside it) that answers questions
 * about code from the files here. Outline and folds come from tree-sitter; definition, usages and
 * hover from the language servers it keeps in a `ServerPool` (at most 4, each stopped after 10
 * idle minutes). With no server live and no question for 10 minutes it exits; the app starts it
 * again on the next question. Lines of JSON both ways: a `SidecarAsk` in, a `SidecarReply` out.
 */
import fs from "node:fs/promises";
import type { Accuracy, Answers, Place, LanguageId } from "./contract.js";
import { LanguageServer } from "./lsp.js";
import { ServerPool } from "./server-pool.js";
import { findServer, serverFamily, typescriptProjects } from "./servers.js";
import { nodeSyntax } from "./syntax-node.js";

export type SidecarQuestion = "documentSymbol" | "foldingRange" | "definition" | "references" | "hover";

export type SidecarAsk =
  | { id: number; question: SidecarQuestion; root: string; file: string; language: LanguageId; at?: Place; text?: string }
  | { id: number; question: "servers" };

/** A language server live in the sidecar, for the machine usage widget and the measurements. */
export interface LiveServer { language: string; root: string; server: string; pid: number | null }

export type SidecarReply =
  | { id: number; answer: unknown; accuracy: Accuracy; by: string; partial?: string }
  | { id: number; servers: LiveServer[] }
  | { id: number; error: string };

export interface SidecarOptions { cap?: number; idleMs?: number }

/** Serve the sidecar's questions from `input` to `output` until `input` ends. */
export function serveSidecar(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, opts: SidecarOptions = {}): void {
  const idleMs = opts.idleMs ?? 10 * 60_000;
  const pool = new ServerPool<LanguageServer>({ cap: opts.cap ?? 4, idleMs });
  const syntax = nodeSyntax();
  const reply = (r: SidecarReply) => output.write(JSON.stringify(r) + "\n");

  let quiet: ReturnType<typeof setTimeout> | null = null;
  const stillAsked = () => {
    if (quiet) clearTimeout(quiet);
    quiet = setTimeout(() => (pool.keys().length ? stillAsked() : process.exit(0)), idleMs);
    quiet.unref?.();
  };

  const serverFor = (language: LanguageId, root: string): Promise<LanguageServer> | null => {
    const key = `${serverFamily(language)}\0${root}`;
    const command = findServer(language, root);
    if (!command) return null;
    return pool.use(key, async () => {
      const s = await LanguageServer.start(command, root, (gone) => pool.exited(key, gone));
      if (serverFamily(language) === "typescript") {
        // The first answer does not wait for every project to load; until they have, usages say so.
        s.partial = "the TypeScript projects loaded so far";
        void typescriptProjects(root).then(async (found) => {
          await s.openAll(found.files);
          s.partial = found.all ? undefined : found.projects ? `the first ${found.projects} TypeScript projects of the workspace` : "the files open in it (the workspace tracks no tsconfig.json)";
        });
      }
      return s;
    });
  };

  async function answer(ask: Exclude<SidecarAsk, { question: "servers" }>): Promise<{ answer: unknown; accuracy: Accuracy; by: string; partial?: string }> {
    if (ask.question === "documentSymbol" || ask.question === "foldingRange") {
      const shape = await syntax.read(ask.language, ask.text ?? await fs.readFile(ask.file, "utf8"));
      return { answer: ask.question === "documentSymbol" ? shape.outline : shape.folding, accuracy: "syntax", by: "tree-sitter" };
    }
    if (!ask.at) throw new Error(`${ask.question} needs a line and column`);
    const server = serverFor(ask.language, ask.root);
    if (!server) return { answer: null, accuracy: "compiler", by: "none" };
    const s = await server;
    const value: Answers["definition"] | Answers["hover"] =
      ask.question === "definition" ? await s.definition(ask.file, ask.at, ask.text)
      : ask.question === "references" ? await s.references(ask.file, ask.at, ask.text)
      : await s.hover(ask.file, ask.at, ask.text);
    return { answer: value, accuracy: "compiler", by: s.command.id, ...(s.partial && ask.question === "references" ? { partial: s.partial } : {}) };
  }

  let buffered = "";
  input.setEncoding?.("utf8");
  input.on("data", (chunk: string) => {
    buffered += chunk;
    let nl: number;
    while ((nl = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      if (!line.trim()) continue;
      let ask: SidecarAsk;
      try { ask = JSON.parse(line); } catch { continue; }
      stillAsked();
      if (ask.question === "servers") {
        const id = ask.id;
        Promise.all(pool.servers().map(([key, s]) => s.then((s) => ({ language: key.split("\0")[0]!, root: s.root, server: s.command.id, pid: s.pid ?? null }), () => null)))
          .then((servers) => reply({ id, servers: servers.filter((s) => s !== null) }));
        continue;
      }
      answer(ask).then((a) => reply({ id: ask.id, ...a }), (e: unknown) => reply({ id: ask.id, error: e instanceof Error ? e.message : String(e) }));
    }
  });
  // The app is gone: stop the servers, giving each a moment to exit on its own.
  input.on("end", () => { pool.close(); setTimeout(() => process.exit(0), 2000); });
  stillAsked();
}
