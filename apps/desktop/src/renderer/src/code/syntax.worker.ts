/**
 * The syntax provider beside the editor: tree-sitter parses the text being edited off the
 * window's thread and gives back its outline and folds. The .wasm files ship with the renderer
 * and are fetched on first use; only the grammars asked for are loaded.
 */
import "./tree-sitter-in-worker";
import * as treeSitterNamespace from "@vscode/tree-sitter-wasm";
import { createSyntax, type TreeSitterModule } from "@hivemind/code-intel/syntax";
import type { LanguageId } from "@hivemind/code-intel/contract";
import runtime from "@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm?url";
import typescript from "@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm?url";
import tsx from "@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm?url";
import javascript from "@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm?url";
import python from "@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm?url";
import rust from "@vscode/tree-sitter-wasm/wasm/tree-sitter-rust.wasm?url";
import go from "@vscode/tree-sitter-wasm/wasm/tree-sitter-go.wasm?url";
import java from "@vscode/tree-sitter-wasm/wasm/tree-sitter-java.wasm?url";

export interface SyntaxAsk { req: number; language: LanguageId; text: string }
export type SyntaxReply = { req: number; outline: unknown; folding: unknown } | { req: number; error: string };

const URLS: Record<string, string> = {
  "tree-sitter": runtime, "tree-sitter-typescript": typescript, "tree-sitter-tsx": tsx, "tree-sitter-javascript": javascript,
  "tree-sitter-python": python, "tree-sitter-rust": rust, "tree-sitter-go": go, "tree-sitter-java": java,
};

// The package is a UMD bundle: the bundler hands it over as the namespace or as its default.
const ns = treeSitterNamespace as unknown as TreeSitterModule & { default?: TreeSitterModule };
const treeSitter: TreeSitterModule = "Parser" in ns && ns.Parser ? ns : ns.default!;

const syntax = createSyntax(treeSitter, async (name) => {
  const url = URLS[name];
  if (!url) throw new Error(`no ${name}.wasm in this build`);
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
});

self.onmessage = (e: MessageEvent<SyntaxAsk>) => {
  const { req, language, text } = e.data;
  syntax.read(language, text).then(
    (shape) => self.postMessage({ req, ...shape } satisfies SyntaxReply),
    (err: unknown) => self.postMessage({ req, error: err instanceof Error ? err.message : String(err) } satisfies SyntaxReply),
  );
};
