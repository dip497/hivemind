/**
 * `hive code-sidecar` (hidden): the code sidecar, run by `hive host` as this same binary. The
 * tree-sitter .wasm files are carried inside a compiled `hive` and read from there.
 */
import { defineCommand } from "citty";
import type { SidecarLaunch } from "@hivemind/code-intel/sidecar-client";
import { useWasmFiles } from "@hivemind/code-intel/syntax-node";
import runtime from "@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm" with { type: "file" };
import typescript from "@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm" with { type: "file" };
import tsx from "@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm" with { type: "file" };
import javascript from "@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm" with { type: "file" };
import python from "@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm" with { type: "file" };
import rust from "@vscode/tree-sitter-wasm/wasm/tree-sitter-rust.wasm" with { type: "file" };
import go from "@vscode/tree-sitter-wasm/wasm/tree-sitter-go.wasm" with { type: "file" };
import java from "@vscode/tree-sitter-wasm/wasm/tree-sitter-java.wasm" with { type: "file" };
import { selfArgv } from "./daemon.js";

/** How `hive host` starts its code sidecar: this binary again. */
export const codeSidecarLaunch = (): SidecarLaunch => {
  const [file, ...args] = selfArgv();
  return { file: file!, args: [...args, "code-sidecar"] };
};

export const codeSidecarCmd = defineCommand({
  meta: { name: "code-sidecar", description: "The code sidecar `hive host` runs: questions about code on stdin, answers on stdout", hidden: true },
  async run() {
    useWasmFiles({
      "tree-sitter": runtime, "tree-sitter-typescript": typescript, "tree-sitter-tsx": tsx, "tree-sitter-javascript": javascript,
      "tree-sitter-python": python, "tree-sitter-rust": rust, "tree-sitter-go": go, "tree-sitter-java": java,
    });
    await import("@hivemind/code-intel/sidecar-main");
    await new Promise<never>(() => { /* the sidecar owns the process now */ });
  },
});
