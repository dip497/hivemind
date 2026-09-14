// Written against real `--help` output captured from each installed CLI.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { choicesFromHelp, choicesFromList, optionArgs, optionChoices } from "../src/options.js";
import type { AgentProviderDef } from "../src/types.js";

const help = (name: string): string =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "help", `${name}.txt`), "utf8");

describe("choices read from a CLI's help", () => {
  test("quoted choices wrapped across lines", () => {
    expect(choicesFromHelp(help("claude"), "--permission-mode"))
      .toEqual(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);
  });

  test("a parenthesised list in the description", () => {
    expect(choicesFromHelp(help("claude"), "--effort")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("clap's inline and bulleted possible values", () => {
    expect(choicesFromHelp(help("codex"), "--sandbox")).toEqual(["read-only", "workspace-write", "danger-full-access"]);
    expect(choicesFromHelp(help("codex"), "--ask-for-approval")).toEqual(["on-request", "never"]);
  });

  test("a pipe list, and a placeholder that only looks like one is ignored", () => {
    expect(choicesFromHelp(help("droid"), "--auto")).toEqual(["low", "medium", "high"]);
    expect(choicesFromHelp(help("claude"), "--autocompact")).toEqual([]);
  });

  test("commander choices on a short option line", () => {
    expect(choicesFromHelp(help("cursor-agent"), "--mode")).toEqual(["plan", "ask"]);
  });

  test("examples in the description are not choices", () => {
    expect(choicesFromHelp(help("cursor-agent"), "--model")).toEqual([]);
  });

  test("a free-text flag, or one the CLI does not have, yields nothing", () => {
    expect(choicesFromHelp(help("claude"), "--model")).toEqual([]);
    expect(choicesFromHelp(help("codex"), "--model")).toEqual([]);
    expect(choicesFromHelp(help("claude"), "--no-such-flag")).toEqual([]);
  });
});

describe("choices read from a listing command", () => {
  test("one value per line", () => {
    expect(choicesFromList(help("opencode-models"), {}).slice(0, 2)).toEqual(["opencode/big-pickle", "opencode/deepseek-v4-flash-free"]);
  });

  test("a table, joined into the form the flag takes", () => {
    expect(choicesFromList(help("pi-list-models"), { skip: 1, format: "{1}/{2}" })[0]).toBe("zai/glm-4.5-air");
  });
});

describe("argv from chosen values", () => {
  const def = {
    id: "x", label: "X", bin: "x", enabled: true, icon: { viewBox: "", body: "" },
    caps: { promptDelivery: "argv", turnSignal: false, resume: "none", supervise: "none", blockedDetection: false },
    options: [
      { id: "mode", label: "Mode", flag: "--permission-mode", values: { bypassPermissions: ["--dangerously-skip-permissions"] } },
      { id: "sandbox", label: "Sandbox", flag: "--sandbox", default: "workspace-write" },
      { id: "model", label: "Model", flag: "--model" },
    ],
  } as AgentProviderDef;

  test("unchosen options pass nothing, except a declared default", () => {
    expect(optionArgs(def, {})).toEqual(["--sandbox", "workspace-write"]);
    expect(optionArgs(def, { model: "" })).toEqual(["--sandbox", "workspace-write"]);
    expect(optionArgs(def, { mode: "default", sandbox: "default" })).toEqual(["--sandbox", "workspace-write"]);
  });

  test("chosen values become flags, and special values their own argv", () => {
    expect(optionArgs(def, { mode: "plan", model: "opus", sandbox: "read-only" }))
      .toEqual(["--permission-mode", "plan", "--sandbox", "read-only", "--model", "opus"]);
    expect(optionArgs(def, { mode: "bypassPermissions" })).toEqual(["--dangerously-skip-permissions", "--sandbox", "workspace-write"]);
  });

  test("a value that names an inherited property is just an unknown value", () => {
    for (const v of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(optionArgs(def, { mode: v })).toEqual(["--permission-mode", v, "--sandbox", "workspace-write"]);
    }
  });

  test("an option with no flag passes only its listed values", () => {
    const flagless = { ...def, options: [{ id: "mode", label: "Mode", values: { yolo: ["--yolo"] } }] } as AgentProviderDef;
    expect(optionArgs(flagless, { mode: "yolo" })).toEqual(["--yolo"]);
    expect(optionArgs(flagless, { mode: "anything-else" })).toEqual([]);
  });

  test("offered choices include special values and the default even when discovery finds none", () => {
    expect(optionChoices(def.options![0]!, [])).toEqual(["bypassPermissions"]);
    expect(optionChoices(def.options![1]!, ["read-only"])).toEqual(["read-only", "workspace-write"]);
  });
});
