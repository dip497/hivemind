/**
 * What a hook says to the control plane for one canonical event, from the agent's payload: the
 * `agent.event` it reports (a closed list of ids and counts, never text the agent wrote), after
 * signing in with the tile's token, and, for an entry that answers, the request for the answer.
 * One owner for the event script and the hook door (hook-door.ts), so both functions are
 * self-contained: the script carries their source.
 */
export interface HookSpec { event: string; kind?: string; outcome?: string; answer?: boolean; reply?: string }

export function hookLines(spec: HookSpec, tileId: string, token: string, e: Record<string, any>): Array<Record<string, unknown>> {
  const out: Record<string, unknown> = { tileId: tileId, event: spec.event };
  if (spec.outcome) out.outcome = spec.outcome;
  if (spec.kind) out.kind = spec.kind;
  if (e.agent_id != null) out.agentId = String(e.agent_id);
  if (typeof e.session_id === "string") out.sessionId = e.session_id;
  if (Array.isArray(e.background_tasks)) {
    const running = e.background_tasks.filter((t: any) => t && t.status === "running").length;
    if (running > 0) out.background = running;
  }
  // Signed in as the agent's own tile first, the host hearing nothing from a connection that is
  // not; as a notification, so nothing is written back to a hook that reads nothing.
  const lines: Array<Record<string, unknown>> = [{ jsonrpc: "2.0", method: "initialize", params: { token: token } }];
  // The turn's reply, ahead of its end, which carries it.
  let said: any = spec.reply ? e : undefined;
  for (const key of spec.reply ? spec.reply.split(".") : []) said = said && typeof said === "object" && Object.prototype.hasOwnProperty.call(said, key) ? said[key] : undefined;
  if (typeof said === "string" && said) {
    // The turn end follows on this connection, which a line longer than the host takes would end:
    // a longer reply is cut to its start.
    const most = 256 * 1024;
    for (let size = JSON.stringify(said).length; size > most; size = JSON.stringify(said).length) said = said.slice(0, Math.floor(said.length * most / size) - 1);
    lines.push({ jsonrpc: "2.0", method: "agent.reply", params: { tileId: tileId, text: said } });
  }
  lines.push({ jsonrpc: "2.0", method: "agent.event", params: out });
  if (!spec.answer) return lines;
  const ask: Record<string, unknown> = { callerTile: tileId, hook: e.hook_event_name, tool: e.tool_name, input: e.tool_input };
  if (out.agentId) ask.agentId = out.agentId;
  lines.push({ jsonrpc: "2.0", id: "answer", method: "agent.await_answer", params: ask });
  return lines;
}

/** What the hook prints for the control plane's reply `m`: undefined until the answer's reply,
 *  then its `stdout` ("" for none). */
export function answerIn(m: any): string | undefined {
  if (!m || m.id !== "answer") return undefined;
  const said = m.result && m.result.stdout;
  return typeof said === "string" ? said : "";
}
