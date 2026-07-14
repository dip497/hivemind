/**
 * TYPECHECK-ONLY companion for `pi-ext-source.ts`.
 *
 * `pi-ext-source.ts` ships the pi extension as a plain-JS STRING (pi loads it as
 * `hive-pi-ext.mjs`, so it must be valid JS — no TS syntax can survive to
 * runtime). That means the string itself can't be type-checked directly. This
 * file is the guardrail: it re-implements, against pi's OFFICIAL
 * `@earendil-works/pi-coding-agent` types, every ExtensionAPI surface the string
 * uses — the event names, the `tool_call` block/allow contract, `registerTool`
 * with a TypeBox schema, and the `AgentToolResult` return shape. If pi renames an
 * event, changes `registerTool`, or reshapes a tool result, THIS file fails
 * `tsc` (run by `pnpm typecheck` via tsconfig.node.json's `src/main/**` glob) —
 * a compile-time canary for the runtime string.
 *
 * It is NEVER imported by runtime code (index.ts / pty-daemon.ts), so Rollup
 * tree-shakes it out of the electron-vite build entirely — zero runtime cost.
 *
 * Keep the surface below IN SYNC with `pi-ext-source.ts`: every `pi.on(...)`
 * event, the tool-result shapes, and the TypeBox param builders used there must
 * appear here so a pi API drift is caught.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Mirror of the fire-and-forget lifecycle bridge in the string. Asserts the event
 *  names pi must keep. The supervise `tool_call` broker was REMOVED (pi has no
 *  permission system — see pi-ext-source.ts), so there is no tool_call mirror here. */
function assertLifecycle(pi: ExtensionAPI): void {
  // Lifecycle bridge — the three events the string posts status/turn from.
  pi.on("agent_start", async () => {
    // no payload needed
  });
  pi.on("message_end", async (event) => {
    const m = event.message;
    // `role` + `content` are what textOf() reads off the assistant message.
    if (m.role === "assistant") void m.content;
  });
  pi.on("agent_end", async (event) => {
    // agent_end carries the full message list the string falls back to.
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const m = event.messages[i];
      if (m && m.role === "assistant") void m.content;
    }
  });

}

/** Mirror of every `pi.registerTool(...)` call in the string. Asserts the
 *  ToolDefinition shape (name/label/description/parameters/execute) and, crucially,
 *  the `AgentToolResult` return shape the string builds (`{ content:[{type:"text",
 *  text}], details }` — note: NO `isError` field exists on AgentToolResult, so the
 *  string encodes failures in content+details, which this file enforces). Also
 *  exercises the TypeBox builders the string uses: Object/String/Optional/Boolean/
 *  Array/Number/Union. */
function assertOrchestrationTools(pi: ExtensionAPI): void {
  const superviseParam = Type.Optional(
    Type.Union([Type.Boolean(), Type.String(), Type.Array(Type.String())]),
  );

  pi.registerTool({
    name: "hive_spawn_agent",
    label: "Spawn hive agent",
    description: "spawn",
    parameters: Type.Object({
      agent: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String()),
      frame: Type.Optional(Type.String()),
      mode: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      supervise: superviseParam,
    }),
    async execute(toolCallId, params, signal) {
      void toolCallId;
      void params.agent;
      void params.supervise;
      void signal;
      // Success shape the string returns.
      return { content: [{ type: "text", text: "ok" }], details: { result: 1 } };
    },
  });

  pi.registerTool({
    name: "hive_read",
    label: "Read hive agent",
    description: "read",
    parameters: Type.Object({
      tileId: Type.String(),
      timeout_ms: Type.Optional(Type.Number()),
    }),
    async execute(toolCallId, params) {
      void toolCallId;
      const n: number | undefined = params.timeout_ms;
      void n;
      // Error shape the string returns (content + details, no isError field).
      return { content: [{ type: "text", text: "hive error: x" }], details: { error: "x" } };
    },
  });

  pi.registerTool({
    name: "hive_send",
    label: "Send to hive agent",
    description: "send",
    parameters: Type.Object({
      tileId: Type.String(),
      text: Type.String(),
      submit: Type.Optional(Type.Boolean()),
    }),
    async execute(toolCallId, params) {
      void toolCallId;
      const s: boolean | undefined = params.submit;
      void s;
      return { content: [{ type: "text", text: params.text }], details: {} };
    },
  });

  pi.registerTool({
    name: "hive_list_tiles",
    label: "List hive tiles",
    description: "list",
    parameters: Type.Object({ frame: Type.Optional(Type.String()) }),
    async execute(toolCallId, params) {
      void toolCallId;
      void params.frame;
      return { content: [{ type: "text", text: "[]" }], details: {} };
    },
  });

  pi.registerTool({
    name: "hive_approve",
    label: "Approve hive worker",
    description: "approve",
    parameters: Type.Object({
      reqId: Type.String(),
      decision: Type.String(),
      reason: Type.Optional(Type.String()),
    }),
    async execute(toolCallId, params) {
      void toolCallId;
      void params.reqId;
      void params.decision;
      void params.reason;
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  });

  pi.registerTool({
    name: "hive_workflow",
    label: "Run hive workflow",
    description: "workflow",
    parameters: Type.Object({
      shape: Type.String(),
      items: Type.Optional(Type.Array(Type.String())),
      prompt: Type.Optional(Type.String()),
      stages: Type.Optional(Type.Array(Type.String())),
      input: Type.Optional(Type.String()),
      reduce_prompt: Type.Optional(Type.String()),
      agent: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      frame: Type.Optional(Type.String()),
      supervise: superviseParam,
      max_concurrent: Type.Optional(Type.Number()),
      timeout_ms: Type.Optional(Type.Number()),
      close_when_done: Type.Optional(Type.Boolean()),
    }),
    async execute(toolCallId, params, signal) {
      void toolCallId;
      void params.shape;
      void params.items;
      void params.stages;
      void signal;
      return { content: [{ type: "text", text: "{}" }], details: {} };
    },
  });
}

/** The extension factory signature pi calls (`export default function (pi) {…}`).
 *  Kept as a typed reference so a change to how pi hands the API in fails here. */
export function piExtTypecheckReference(pi: ExtensionAPI): void {
  assertLifecycle(pi);
  assertOrchestrationTools(pi);
}
