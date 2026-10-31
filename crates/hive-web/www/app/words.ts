// What the screens say, as the Android app says it (its strings.xml).

export function ago(since: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

/** How long, as a clock reads it: 12s, 1m 02s, 1h 05m. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${two(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${two(Math.floor(s / 60) % 60)}m`;
}

const STATES: Record<string, string> = {
  idle: "idle", working: "working", waiting: "waiting on you", done: "done",
  failed: "failed", interrupted: "interrupted", limited: "limited", exited: "exited",
};
export const stateLabel = (state: string) => STATES[state] ?? state;

const KINDS: Record<string, string> = { permission: "permission", question: "question", plan: "plan" };
export const kindLabel = (kind: string) => KINDS[kind] ?? "waiting on you";

export const where = (workspace: string, machine: string) => `${workspace} · ${machine}`;

export function noneWaiting(working: number): string {
  if (working === 0) return "Nothing needs you.";
  return `Nothing needs you. ${working} ${working === 1 ? "agent" : "agents"} working.`;
}

/** What it means when an action did not land. */
export const NOTICES = {
  answered: "It no longer waits on you.",
  notRunning: "No agent runs there now.",
  notTaken: "It was not taken: no agent runs there now, or it holds too many messages already.",
  starting: "Starting…",
  notStopped: "It was not in a turn.",
  closed: "It was already closed.",
  unconfirmed: "Not confirmed: check the chat.",
};

/** An error, as the person is told it. */
export const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
