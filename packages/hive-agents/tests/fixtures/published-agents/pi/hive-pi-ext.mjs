// pi lifecycle → HCP bridge + native hive orchestration tools.
// Loaded via `pi -e <this file>`; no-ops unless hivemind injected HIVE_HCP_SOCK + HIVEMIND_TILE.
// Self-contained: only node built-ins + `typebox` (typebox is bundled with pi at runtime).
import net from "node:net";
import { execFile } from "node:child_process";
import { Type } from "typebox";

export default function (pi) {
  const sock = process.env.HIVE_HCP_SOCK;
  const tile = process.env.HIVEMIND_TILE;
  const token = process.env.HCP_TOKEN;
  if (!sock || !tile) return; // not spawned by hivemind → stay a plain pi session

  // ── lifecycle bridge: fire-and-forget JSON-RPC notification, signed in with the tile's token ──
  const post = (method, params) => {
    try {
      const c = net.connect(sock, () => {
        try {
          c.write(JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: { token: token } }) + "\n"
            + JSON.stringify({ jsonrpc: "2.0", method: method, params: params }) + "\n");
        } catch (e) {}
        try { c.end(); } catch (e) {}
      });
      c.on("error", () => {});
    } catch (e) {}
  };

  const textOf = (m) => {
    if (!m) return "";
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.filter((b) => b && b.type === "text").map((b) => b.text || "").join("");
    return "";
  };

  let lastText = "";
  pi.on("agent_start", async () => { lastText = ""; post("agent.event", { tileId: tile, event: "turn.started" }); });
  pi.on("message_end", async (event) => {
    const m = event && event.message;
    if (m && m.role === "assistant") { const t = textOf(m); if (t) lastText = t; }
  });
  pi.on("agent_end", async (event) => {
    // Prefer the accumulated assistant text; fall back to the last assistant message in event.messages.
    let text = lastText;
    if (!text && event && Array.isArray(event.messages)) {
      for (let i = event.messages.length - 1; i >= 0; i--) {
        const m = event.messages[i];
        if (m && m.role === "assistant") { const t = textOf(m); if (t) { text = t; break; } }
      }
    }
    // The reply first, on its own token-gated request; then the turn end it belongs to.
    if (text) await reply(text);
    post("agent.event", { tileId: tile, event: "turn.ended" });
  });

  // ── the reply, on its own token-gated request (initialize, then agent.reply). NEVER rejects,
  //    NEVER hangs: any socket error / close / timeout settles it. ──
  const reply = (text) => new Promise((resolve) => {
    let c = null;
    const done = () => { try { if (c) c.end(); } catch (e) {} resolve(); };
    try {
      c = net.connect(sock, () => {
        try {
          c.write(JSON.stringify({ jsonrpc: "2.0", id: "init", method: "initialize", params: { token: token } }) + "\n"
            + JSON.stringify({ jsonrpc: "2.0", id: "reply", method: "agent.reply", params: { tileId: tile, text: text } }) + "\n");
        } catch (e) { done(); }
      });
    } catch (e) { resolve(); return; }
    let buf = "";
    c.on("data", (d) => { buf += d.toString("utf8"); if (buf.split("\n").some((l) => { try { return JSON.parse(l).id === "reply"; } catch (e) { return false; } })) done(); });
    c.on("error", done);
    c.on("close", done);
    const timer = setTimeout(done, 5000);
    if (typeof timer.unref === "function") timer.unref();
  });

  // ── NO SUPERVISE FOR PI (deliberate) ──────────────────────────────────────
  // pi workers are NOT supervisable, and hivemind refuses 'supervise' for them at
  // spawn (see methods.ts doSpawn) rather than pretending. There used to be a
  // 'tool_call' broker here; it is gone on purpose:
  //
  //  - pi has NO permission system. Nothing in its core asks before a tool runs, so
  //    a broker here isn't restoring a gate pi normally has — it's inventing one
  //    that exists nowhere else in pi's life (a pi tile the USER opens is already
  //    fully autonomous).
  //  - With no native prompt to fall through to, the broker had to fail CLOSED. Any
  //    hiccup — a busy supervisor, a slow answer, a socket blip — refused EVERY tool
  //    and bricked the worker mid-task.
  //  - And the "supervisor" is another LLM, not a human. LLM-approving-LLM, at
  //    minutes of latency, in a repo the user already trusted both agents with.
  //
  // Need a gated worker? Spawn CLAUDE with 'supervise' — its PreToolUse broker fails
  // open to claude's own permission prompt, so a lost approval still stops at a human.

  // ── NATIVE HIVE ORCHESTRATION TOOLS ───────────────────────────────────────
  // Each runs `hive ctl … --json`, as every agent drives hive, when this tile has its token.
  if (!token) return;
  const ORCH_TIMEOUT_MS = 60 * 60 * 1000; // generous ceiling; a long workflow blocks in the CLI, not us

  const ctl = (args, signal) => new Promise((resolve) => {
    execFile("hive", ["ctl"].concat(args, ["--json"]), { signal: signal, timeout: ORCH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      // A result is printed even when the exit code says how it ended (a read that timed out).
      let result;
      const last = String(stdout || "").trim().split("\n").pop();
      try { result = last ? JSON.parse(last) : undefined; } catch (e) {}
      if (result !== undefined && !(result && result.ok === false && result.code)) {
        resolve({ content: [{ type: "text", text: JSON.stringify(result) }], details: result });
        return;
      }
      const msg = (result && result.message) || String(stderr || "").trim() || (err && err.message) || "no answer from hive";
      // AgentToolResult has no isError field — encode the failure in the text + details.
      resolve({ content: [{ type: "text", text: "hive error: " + msg }], details: { error: msg } });
    });
  });
  /** `--flag value` for each value given. */
  const flags = (o) => Object.keys(o).reduce((a, k) => (o[k] == null || o[k] === "" ? a : a.concat(["--" + k, String(o[k])])), []);
  const toolList = (v) => (Array.isArray(v) ? v.join(",") : v);

  // CLAUDE workers only — a pi worker cannot be supervised (pi has no permission
  // system to broker); asking for it is a spawn ERROR, not a silent downgrade.
  const superviseParam = Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], {
    description: "CLAUDE workers only — supervising a 'pi' worker is an ERROR (pi has no permission system; a pi worker always runs autonomously). 'all', or the tools to broker. Routes a claude worker's tool-permission prompts to YOU to answer with hive_approve.",
  }));

  pi.registerTool({
    name: "hive_spawn_agent",
    label: "Spawn hive agent",
    description:
      "Spawn a NEW coding agent as a tile on the hivemind canvas and hand it a prompt. Returns its tile id. Delegate a subtask to a sibling agent. By default the worker AUTO-REPORTS: its reply is delivered back into your session when it finishes a turn. Pass `supervise` (CLAUDE workers only) to route the worker's tool-permission prompts to YOU (answer with hive_approve); supervising a pi worker is an error.",
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Agent to launch: 'claude' (default), 'codex', 'droid', 'pi', …" })),
      name: Type.Optional(Type.String({ description: "Short display name ('reviewer', 'test-writer') — becomes the worker's tile label and tags every message it reports back to you. Name your workers when you spawn more than one." })),
      prompt: Type.Optional(Type.String({ description: "Initial task delivered once the agent is ready." })),
      frame: Type.Optional(Type.String({ description: "Frame to spawn into, by its id or name (hive_list_frames). Omit to use your own frame." })),
      mode: Type.Optional(Type.String({ description: "Permission mode. Omit → the worker runs autonomously. Pass 'plan'/'acceptEdits'/'default' to keep a human in the loop." })),
      model: Type.Optional(Type.String({ description: "Model alias like 'opus' or 'sonnet'." })),
      supervise: superviseParam,
    }),
    async execute(toolCallId, params, signal) {
      return ctl(["spawn"].concat(flags({ agent: params.agent, name: params.name, prompt: params.prompt, frame: params.frame, mode: params.mode, model: params.model, supervise: toolList(params.supervise) })), signal);
    },
  });

  pi.registerTool({
    name: "hive_read",
    label: "Read hive agent",
    description:
      "Block until a spawned agent (by tile id) finishes its current turn, then return its reply. On timeout returns finalStatus:'timeout' (the agent is still working). Most of the time you don't need this — workers auto-deliver their replies.",
    parameters: Type.Object({
      tileId: Type.String({ description: "The worker's tile id (from hive_spawn_agent)." }),
      timeout_ms: Type.Optional(Type.Number({ description: "Max wait in ms (default 100000)." })),
    }),
    async execute(toolCallId, params, signal) {
      return ctl(["read", params.tileId].concat(typeof params.timeout_ms === "number" ? ["--timeout", Math.max(0, Math.floor(params.timeout_ms)) + "ms"] : []), signal);
    },
  });

  pi.registerTool({
    name: "hive_send",
    label: "Send to hive agent",
    description:
      "Send a message to an agent (by tile id): it is typed in as its next prompt once it is at its prompt. Use for follow-up turns in a conversation with a spawned agent.",
    parameters: Type.Object({ tileId: Type.String(), text: Type.String() }),
    async execute(toolCallId, params, signal) {
      return ctl(["send", params.tileId, params.text], signal);
    },
  });

  pi.registerTool({
    name: "hive_report",
    label: "Report to spawner",
    description:
      "Report a result back to the agent that SPAWNED you (your parent). If you were launched by another agent via hive_spawn_agent, call this when you finish your delegated task — your message is delivered into the parent's session so it can collect your findings without polling. Prefer a concise summary over dumping everything. An error if you have no parent.",
    parameters: Type.Object({
      message: Type.String({ description: "Your result/findings to send to the parent agent." }),
    }),
    async execute(toolCallId, params, signal) {
      return ctl(["report", params.message], signal);
    },
  });

  pi.registerTool({
    name: "hive_list_frames",
    label: "List hive frames",
    description:
      "List the workspace's frames, where an agent may be started — each with its id, name and the machine it runs on.",
    parameters: Type.Object({}),
    async execute(toolCallId, params, signal) {
      return ctl(["frames"], signal);
    },
  });

  pi.registerTool({
    name: "hive_list_agents",
    label: "List hive agents",
    description:
      "List the workspace's agents — returns { seq, agents:[{ tile, agent, program, state, waiting?, parent? }] }: each agent's tile, name, what it runs, whether it is working, idle, done or waiting, and on what.",
    parameters: Type.Object({}),
    async execute(toolCallId, params, signal) {
      return ctl(["agents"], signal);
    },
  });

  pi.registerTool({
    name: "hive_focus",
    label: "Focus a hive tile",
    description:
      "Bring a tile (by tile id) into view and select it on the canvas, so the user sees it.",
    parameters: Type.Object({ tileId: Type.String() }),
    async execute(toolCallId, params, signal) {
      return ctl(["focus", params.tileId], signal);
    },
  });

  pi.registerTool({
    name: "hive_close_tile",
    label: "Close a hive agent",
    description:
      "Close an agent (by tile id) — ends its session and removes its tile. Use to clean up a worker you spawned once you've collected its result.",
    parameters: Type.Object({ tileId: Type.String() }),
    async execute(toolCallId, params, signal) {
      return ctl(["close", params.tileId], signal);
    },
  });

  pi.registerTool({
    name: "hive_connect",
    label: "Pipe hive agents",
    description:
      "Pipe one agent's output into another's input: whenever the source agent (srcTileId) finishes a turn, its reply is automatically sent to the destination agent (dstTileId). Chains workers without you relaying by hand.",
    parameters: Type.Object({ srcTileId: Type.String(), dstTileId: Type.String() }),
    async execute(toolCallId, params, signal) {
      return ctl(["connect", params.srcTileId, params.dstTileId], signal);
    },
  });

  pi.registerTool({
    name: "hive_disconnect",
    label: "Unpipe hive agents",
    description:
      "Remove a pipe created with hive_connect. Omit dstTileId to remove ALL pipes out of srcTileId.",
    parameters: Type.Object({ srcTileId: Type.String(), dstTileId: Type.Optional(Type.String()) }),
    async execute(toolCallId, params, signal) {
      return ctl(["disconnect", params.srcTileId].concat(typeof params.dstTileId === "string" ? [params.dstTileId] : []), signal);
    },
  });

  pi.registerTool({
    name: "hive_send_keys",
    label: "Send keys to a hive agent",
    description:
      "Send symbolic keystrokes to a tile (by tile id) — e.g. ['Down','Enter'] to pick a menu item, ['Escape'] to cancel, ['C-c'] for Ctrl-C. For a message use hive_send instead; this is for navigating a TUI's prompts.",
    parameters: Type.Object({ tileId: Type.String(), keys: Type.Array(Type.String()) }),
    async execute(toolCallId, params, signal) {
      return ctl(["keys", params.tileId, params.keys.join(",")], signal);
    },
  });

  pi.registerTool({
    name: "hive_approve",
    label: "Approve hive worker",
    description:
      "Answer an approval request from a supervised worker (spawned with `supervise`). When a worker wants to run a brokered tool you'll get a '[hive] APPROVAL — worker <id> wants to run <tool>' message with a request id; call this with it. decision: 'allow'/'deny' for this one call, or 'always'/'never' to also remember it for that worker+tool.",
    parameters: Type.Object({
      reqId: Type.String({ description: "The approval request id from the '[hive] APPROVAL …' message." }),
      decision: Type.String({ description: "allow | deny | always | never." }),
      reason: Type.Optional(Type.String({ description: "Optional note shown to the worker (useful on deny)." })),
    }),
    async execute(toolCallId, params, signal) {
      return ctl(["approve", params.reqId, params.decision].concat(flags({ reason: params.reason })), signal);
    },
  });

  pi.registerTool({
    name: "hive_workflow",
    label: "Run hive workflow",
    description:
      "Run a MULTI-AGENT WORKFLOW: spawn a fleet of worker agents as visible tiles, drive them, and BLOCK until done — then return their replies aggregated. shape: 'fanout' (one worker per items[i], `prompt` is a template with {item}); 'mapreduce' (fanout then one reducer fed all outputs via `reduce_prompt` with {results}); 'pipeline' (sequential `stages`, each may use {input} for the prior stage's reply). Each worker result carries a status ('turn'|'timeout'|'closed'|'error').",
    parameters: Type.Object({
      shape: Type.String({ description: "fanout | pipeline | mapreduce." }),
      items: Type.Optional(Type.Array(Type.String(), { description: "fanout/mapreduce: one worker per element, substituted into {item}." })),
      prompt: Type.Optional(Type.String({ description: "fanout/mapreduce: the per-worker task. Use {item}." })),
      stages: Type.Optional(Type.Array(Type.String(), { description: "pipeline: one prompt per stage. Each may use {input}." })),
      input: Type.Optional(Type.String({ description: "pipeline: optional seed for the first stage's {input}." })),
      reduce_prompt: Type.Optional(Type.String({ description: "mapreduce: the reducer prompt. Use {results}." })),
      agent: Type.Optional(Type.String({ description: "Runtime for every worker: 'claude' (default), 'codex', 'droid', 'pi', …" })),
      model: Type.Optional(Type.String({ description: "Model alias applied to every worker." })),
      frame: Type.Optional(Type.String({ description: "Frame to spawn workers into, by its id or name. Omit to use your own frame." })),
      supervise: superviseParam,
      max_concurrent: Type.Optional(Type.Number({ description: "Max workers live at once (default 6, capped 12)." })),
      timeout_ms: Type.Optional(Type.Number({ description: "Per-worker turn ceiling in ms (default 600000)." })),
      close_when_done: Type.Optional(Type.Boolean({ description: "Close each worker tile after collecting its reply (default false)." })),
    }),
    async execute(toolCallId, params, signal) {
      return ctl(["workflow"].concat(flags({
        shape: params.shape, items: params.items && params.items.join("||"), prompt: params.prompt,
        stages: params.stages && params.stages.join("||"), input: params.input, "reduce-prompt": params.reduce_prompt,
        agent: params.agent, model: params.model, frame: params.frame, supervise: toolList(params.supervise),
        "max-concurrent": params.max_concurrent, timeout: typeof params.timeout_ms === "number" ? Math.floor(params.timeout_ms) + "ms" : undefined,
      }), params.close_when_done ? ["--close"] : []), signal);
    },
  });
}
