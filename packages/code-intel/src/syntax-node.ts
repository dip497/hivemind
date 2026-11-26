/** The syntax provider in Node (the sidecar, tests): the .wasm files read from the installed package. */
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import * as treeSitterNamespace from "@vscode/tree-sitter-wasm";
import { createSyntax, type Syntax, type TreeSitterModule } from "./syntax.js";

// The package is a UMD bundle: Node hands it over as the namespace's default, a bundler as the namespace.
const ns = treeSitterNamespace as unknown as TreeSitterModule & { default?: TreeSitterModule };
const treeSitter: TreeSitterModule = "Parser" in ns && ns.Parser ? ns : ns.default!;

let syntax: Syntax | null = null;
/** The .wasm files by name where a build carries them inside itself (a compiled `hive`). */
let carried: Record<string, string> | null = null;

/** Read the .wasm files from these paths, by name without `.wasm`. Before the first question. */
export function useWasmFiles(files: Record<string, string>): void { carried = files; }

/** Where the .wasm files are: where the app says (`HIVEMIND_TREE_SITTER_DIR`), else the package. */
const wasmDir = (): string =>
  process.env.HIVEMIND_TREE_SITTER_DIR || path.dirname(createRequire(import.meta.url).resolve("@vscode/tree-sitter-wasm"));

export function nodeSyntax(): Syntax {
  if (syntax) return syntax;
  const files = carried;
  const dir = files ? "" : wasmDir();
  syntax = createSyntax(treeSitter, async (name) => {
    const file = files ? files[name] : path.join(dir, `${name}.wasm`);
    if (!file) throw new Error(`this build carries no ${name}.wasm`);
    return new Uint8Array(await fs.readFile(file));
  });
  return syntax;
}
