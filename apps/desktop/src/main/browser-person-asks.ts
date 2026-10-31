/**
 * What an agent asks the person on a Browser tile: to do something in the page themselves (sign in,
 * pass a captcha), or for a yes to signing in with a saved sign-in. The question shows on the tile
 * wherever it is seen, and the agent waits on the answer in short requests. A person says it, on a
 * window or a page the app serves; an agent cannot answer its own.
 */
import { broadcast } from "./windows.js";

export type PersonAskAbout =
  | { kind: "hand-over"; words: string }
  | { kind: "sign-in"; name: string; site: string; username: string };
export type PersonAsk = { ask: number; tile: string; by: string | null } & PersonAskAbout;

export type PersonAnswer = "yes" | "always" | "no" | "done";
export type AskState =
  | { state: "waiting" }
  | { state: "working" }
  | { state: "done"; outcome: "done" | "no" | "expired" | "sent" | "person"; url?: string; why?: string };

/** How long a question stays up. */
const ASK_FOR_MS = 5 * 60_000;
/** How long an agent can still read how a question ended. */
const KEPT_FOR_MS = 5 * 60_000;

interface Held {
  ask: PersonAsk;
  state: AskState;
  listeners: Set<() => void>;
  expires?: ReturnType<typeof setTimeout>;
  /** What a yes goes on to do; none: the answer is all it asked. */
  onYes?: (always: boolean) => Promise<AskState>;
  /** The question is no longer up. */
  onEnd?: () => void;
}

const asks = new Map<number, Held>();
let lastAsk = 0;

function settle(held: Held, state: AskState): void {
  held.state = state;
  if (held.expires) clearTimeout(held.expires);
  held.expires = undefined;
  if (state.state === "done") setTimeout(() => asks.delete(held.ask.ask), KEPT_FOR_MS).unref?.();
  held.onEnd?.();
  held.onEnd = undefined;
  broadcast("browser:person-ask", { ask: held.ask.ask, tile: held.ask.tile, ended: true });
  for (const hear of held.listeners) hear();
}

/** Put a question on `tile`. Only one at a time waits on a tile. */
export function askPerson(tile: string, by: string | null, about: PersonAskAbout, onYes?: Held["onYes"], onEnd?: () => void): number | null {
  if ([...asks.values()].some((h) => h.ask.tile === tile && h.state.state === "waiting")) return null;
  const ask: PersonAsk = { ask: ++lastAsk, tile, by, ...about };
  const held: Held = { ask, state: { state: "waiting" }, listeners: new Set(), onYes, onEnd };
  held.expires = setTimeout(() => settle(held, { state: "done", outcome: "expired" }), ASK_FOR_MS);
  asks.set(ask.ask, held);
  broadcast("browser:person-ask", ask);
  return ask.ask;
}

/** Carry on with `ask` as if the person had said yes: they already said so for good. */
export function goAhead(tile: string, by: string | null, about: PersonAskAbout, work: NonNullable<Held["onYes"]>): number {
  const ask: PersonAsk = { ask: ++lastAsk, tile, by, ...about };
  const held: Held = { ask, state: { state: "working" }, listeners: new Set() };
  asks.set(ask.ask, held);
  void work(false).then((state) => settle(held, state), (e: unknown) => settle(held, { state: "done", outcome: "person", why: e instanceof Error ? e.message : String(e) }));
  return ask.ask;
}

/** The person's answer. False when it is no longer waiting. */
export function answerAsk(ask: number, answer: PersonAnswer): boolean {
  const held = asks.get(ask);
  if (!held || held.state.state !== "waiting") return false;
  if (answer === "no") settle(held, { state: "done", outcome: "no" });
  else if (!held.onYes) settle(held, { state: "done", outcome: "done" });
  else {
    settle(held, { state: "working" });
    void held.onYes(answer === "always").then((state) => settle(held, state), (e: unknown) => settle(held, { state: "done", outcome: "person", why: e instanceof Error ? e.message : String(e) }));
  }
  return true;
}

/** The questions waiting on the person now. */
export const waitingAsks = (): PersonAsk[] => [...asks.values()].filter((h) => h.state.state === "waiting").map((h) => h.ask);

/** Where `ask` stands, as soon as it is done or after `ms`. Null: no such ask. */
export function askState(ask: number, ms: number): Promise<AskState | null> {
  const held = asks.get(ask);
  if (!held) return Promise.resolve(null);
  if (held.state.state === "done" || ms <= 0) return Promise.resolve(held.state);
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      held.listeners.delete(hear);
      resolve(held.state);
    };
    const hear = () => { if (held.state.state === "done") finish(); };
    const timer = setTimeout(finish, ms);
    held.listeners.add(hear);
  });
}

/** A tile's page has gone: nobody can answer its questions. */
export function endAsksOf(tile: string): void {
  for (const held of asks.values()) {
    if (held.ask.tile === tile && held.state.state === "waiting") settle(held, { state: "done", outcome: "expired" });
  }
}
