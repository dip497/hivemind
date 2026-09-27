// OpenCode's plugin, loaded the way OpenCode loads it: its session events become the host's,
// in order, with the reply before the turn ends and a subagent's turns kept apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SDK_ENV, SDK_FILE, sdkSource } from "@hivemind/agent-sdk";
import { authoredDef } from "./authored-agents.ts";

type Line = { method?: string; id?: string; params?: Record<string, unknown> };

test("turns, replies, questions, permissions and subagents", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-plugin-"));
  fs.writeFileSync(path.join(dir, SDK_FILE), sdkSource());
  const sock = path.join(dir, "hcp.sock");
  const got: Line[] = [];
  const server = net.createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const m = JSON.parse(buf.slice(0, nl)) as Line; buf = buf.slice(nl + 1);
        if (m.method !== "initialize") got.push(m);
        if (m.id) c.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  Object.assign(process.env, { HIVEMIND_TILE: "hm:t1", HCP_TOKEN: "tok", [SDK_ENV.sdk]: path.join(dir, SDK_FILE), [SDK_ENV.sock]: sock });

  const mod = await import(pathToFileURL(path.join(authoredDef("opencode").dir!, "hive-opencode.js")).href);
  const hooks = await mod.HivePlugin({});
  const ev = (type: string, properties: Record<string, unknown>) => hooks.event({ event: { type, properties } });
  await ev("session.created", { info: { id: "root" } });
  await ev("session.status", { sessionID: "root", status: { type: "busy" } });
  await ev("session.status", { sessionID: "root", status: { type: "retry" } });
  await ev("session.status", { sessionID: "root", status: { type: "busy" } });
  await ev("session.created", { info: { id: "child", parentID: "root" } });
  await ev("session.status", { sessionID: "child", status: { type: "busy" } });
  await ev("message.updated", { info: { id: "m-child", role: "assistant", sessionID: "child" } });
  await ev("message.part.updated", { part: { id: "p0", messageID: "m-child", sessionID: "child", type: "text", text: "child says" } });
  await ev("session.status", { sessionID: "child", status: { type: "idle" } });
  await ev("permission.asked", { sessionID: "root" });
  await ev("permission.replied", { sessionID: "root" });
  await ev("question.asked", { sessionID: "root" });
  await ev("question.rejected", { sessionID: "root" });
  await ev("message.updated", { info: { id: "m1", role: "assistant", sessionID: "root" } });
  await ev("message.part.updated", { part: { id: "p1", messageID: "m1", sessionID: "root", type: "text", text: "all " } });
  await ev("message.part.updated", { part: { id: "p2", messageID: "m1", sessionID: "root", type: "text", text: "green" } });
  await ev("session.status", { sessionID: "root", status: { type: "idle" } });
  // A second turn that the user stops.
  await ev("session.status", { sessionID: "root", status: { type: "busy" } });
  await ev("session.error", { sessionID: "root", error: { name: "MessageAbortedError" } });
  await ev("session.status", { sessionID: "root", status: { type: "idle" } });

  await new Promise((r) => setTimeout(r, 300));
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const seen = got.map((m) => m.method === "agent.reply" ? `reply:${m.params!.text}` : [m.params!.event, m.params!.kind ?? m.params!.outcome ?? m.params!.agentId].filter(Boolean).join(":"));
  assert.deepEqual(seen, [
    "turn.started",
    "subagent.started:child",
    "subagent.stopped:child",
    "input.requested:permission", "input.resolved",
    "input.requested:question", "input.resolved",
    "reply:all green", "turn.ended:done",
    "turn.started", "turn.ended:interrupted",
  ]);
});
