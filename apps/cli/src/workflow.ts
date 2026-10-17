/**
 * `hive ctl workflow`: workers started, each one's reply read and gathered, from the workspace
 * API alone — `agent.start`, `agent.read`, `agent.close` — as whoever drives it.
 */
import type { AgentRead } from "@hivemind/workspace-api/agents";
import { readSchedule, type WorkflowPlan } from "./ctl-args.js";
import { HcpCliError } from "./hcp.js";
import type { Drive } from "./drive.js";

/** Slack on one read slice's answer, for the reply to be taken from the transcript. */
export const READ_SLACK_MS = 5_000;
/** A spawn the host turns away for coming too fast is tried again this often, this many times. */
const START_RETRY_MS = 1_500;
const START_RETRIES = 6;

/** Wait up to `totalMs` for an agent's turn: its reply, or where the wait ended. */
export async function readTurn(d: Pick<Drive, "call">, tile: string, totalMs: number): Promise<AgentRead> {
  let last!: AgentRead;
  for (const slice of readSchedule(totalMs)) {
    last = await d.call("agent.read", [tile, slice], slice + READ_SLACK_MS) as AgentRead;
    if (last.finalStatus !== "timeout") return last;
  }
  return last;
}

export interface WorkerResult {
  item: string;
  tile: string | null;
  status: AgentRead["finalStatus"] | "error";
  text: string | null;
}

export type WorkflowResult =
  | { shape: "fanout"; items: WorkerResult[] }
  | { shape: "mapreduce"; items: WorkerResult[]; reduced: string | null; reducerStatus: WorkerResult["status"] }
  | { shape: "pipeline"; steps: WorkerResult[]; output: string | null };

/** Run `plan` in workspace `repo`. A worker that cannot be started, or whose turn does not end,
 *  is in the result as such; the run goes on without it, except a pipeline, which stops there. */
export async function runWorkflow(d: Pick<Drive, "call">, repo: string, plan: WorkflowPlan, wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Promise<WorkflowResult> {
  const start = async (name: string, prompt: string): Promise<string> => {
    const spec = {
      program: plan.program, prompt, name, report: false,
      ...(plan.model ? { model: plan.model } : {}),
      ...(plan.frame ? { frame: plan.frame } : {}),
      ...(plan.supervise ? { supervise: plan.supervise } : {}),
    };
    for (let tries = 0; ; tries++) {
      try {
        return ((await d.call("agent.start", [repo, spec])) as { tile: string }).tile;
      } catch (e) {
        if (!(e instanceof HcpCliError && e.code === "RATE_LIMITED") || tries >= START_RETRIES) throw e;
        await wait(START_RETRY_MS);
      }
    }
  };
  const worker = async (item: string, prompt: string): Promise<WorkerResult> => {
    let tile: string;
    try { tile = await start(item, prompt); } catch (e) { return { item, tile: null, status: "error", text: (e as Error).message }; }
    const r = await readTurn(d, tile, plan.turnMs);
    if (plan.close && r.finalStatus === "turn") await d.call("agent.close", [tile]).catch(() => {});
    return { item, tile, status: r.finalStatus, text: r.text || null };
  };

  if (plan.shape === "pipeline") {
    const steps: WorkerResult[] = [];
    let input = plan.input;
    for (const [i, stage] of plan.stages.entries()) {
      const r = await worker(`stage ${i + 1}`, stage.replace(/\{input\}/g, input ?? ""));
      steps.push(r);
      if (r.status !== "turn") break;
      input = r.text;
    }
    return { shape: "pipeline", steps, output: input };
  }

  // At most `concurrency` workers at once, each result in its item's place.
  const items = new Array<WorkerResult>(plan.items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    for (let i = next++; i < plan.items.length; i = next++) items[i] = await worker(plan.items[i]!, plan.prompt.replace(/\{item\}/g, plan.items[i]!));
  };
  await Promise.all(Array.from({ length: Math.min(plan.concurrency, plan.items.length) }, lane));
  if (plan.shape === "fanout") return { shape: "fanout", items };
  const results = items.map((r) => `## ${r.item}\n${r.text ?? "(no output)"}`).join("\n\n");
  const reducer = await worker("(reduce)", plan.reducePrompt.replace(/\{results\}/g, results));
  return { shape: "mapreduce", items, reduced: reducer.text, reducerStatus: reducer.status };
}
