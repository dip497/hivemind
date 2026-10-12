/**
 * What a hook says to the control plane for one canonical event, from the agent's payload: the
 * `agent.event` it reports (a closed list of ids and counts, never text the agent wrote) and, for
 * an entry that answers, the request for the answer. One owner for the event script and the http
 * front, so both functions are self-contained: the script carries their source.
 */
export interface HookSpec { event: string; kind?: string; outcome?: string; answer?: boolean }

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
  const lines: Array<Record<string, unknown>> = [{ jsonrpc: "2.0", method: "agent.event", params: out }];
  if (!spec.answer) return lines;
  const ask: Record<string, unknown> = { callerTile: tileId, hook: e.hook_event_name, tool: e.tool_name, input: e.tool_input };
  if (out.agentId) ask.agentId = out.agentId;
  lines.push({ jsonrpc: "2.0", id: "init", method: "initialize", params: { token: token } });
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
