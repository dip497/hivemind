// Three people type in one sticky note at once (design §4.4): a host and two replicas of its
// workspace, over sync channels whose frames arrive late and interleaved between the channels (in
// order on each, as a stream keeps them); each person's window writes its whole note from what it
// last read, hears of others' changes late (as a notice over IPC does), so it often writes from a
// reading already out of date, and takes others' changes as the app's window does (rebaseBoard).
// However the typing and the arrivals interleave, all three end with the same text, holding every
// character anyone typed, once.
import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rebaseBoard } from "@hivemind/workspace-doc/rebase";
import type { BoardObject } from "@hivemind/workspace-doc/shapes";
import { WorkspaceStore, type WorkspaceChange } from "../src/store.ts";
import { parseSync, replicate, serveReplica, type SyncChannel } from "../src/doc-sync.ts";
import { newSeed } from "../src/identity.ts";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "one-note-")); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A seeded random number generator, so a failing interleaving can be run again. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function storeWith(dir: string, person?: Uint8Array) {
  const listeners = new Set<(c: WorkspaceChange) => void>();
  const store = new WorkspaceStore({ dir: path.join(tmp, dir), person, onChange: (c) => { for (const l of listeners) l(c); } });
  const changes = (l: (c: WorkspaceChange) => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
  return { store, changes };
}

/** Two ends of a channel whose frames wait in `pending` until delivered, in order each way. */
function lateChannel(pending: Array<Array<() => void>>): [SyncChannel, SyncChannel] {
  const toA: Array<() => void> = [];
  const toB: Array<() => void> = [];
  pending.push(toA, toB);
  const a = new Set<(t: string) => void>();
  const b = new Set<(t: string) => void>();
  return [
    { send: (t) => { toB.push(() => { for (const l of b) l(t); }); }, on: (l) => { a.add(l); return () => { a.delete(l); }; } },
    { send: (t) => { toA.push(() => { for (const l of a) l(t); }); }, on: (l) => { b.add(l); return () => { b.delete(l); }; } },
  ];
}

const note = (text: string): BoardObject => ({ id: "n1", kind: "note", x: 10, y: 20, w: 200, h: 160, text } as BoardObject);
const textOf = (board: BoardObject[]) => (board.find((o) => o.id === "n1") as { text: string } | undefined)?.text ?? "";

/** A person's window on `repo` in `store`: it types into its note and writes the whole board from
 *  what it last read, and reads others' changes as the app's window does. */
class Window {
  private base: BoardObject[];
  board: BoardObject[];
  /** Others' changes reach the window at once, or late, as a notice over IPC can: `later` holds
   *  them then. */
  constructor(private readonly store: WorkspaceStore, private readonly repo: string, private readonly writer: string, changes: (l: (c: WorkspaceChange) => void) => void, later: Array<() => void> | null) {
    this.base = store.getObjects(repo);
    this.board = this.base;
    changes((c) => {
      if (c.repo !== repo || c.writer === writer) return;
      if (later) later.push(() => this.read());
      else this.read();
    });
  }
  /** Type `token` at `at` (0 to 1) of the way through the note, never inside another token. */
  type(token: string, at: number): void {
    const units = textOf(this.board).match(/<[^>]*>|./g) ?? [];
    units.splice(Math.floor(at * (units.length + 1)), 0, token);
    const text = units.join("");
    this.board = this.board.map((o) => (o.id === "n1" ? ({ ...o, text } as BoardObject) : o));
    this.store.setObjects(this.repo, this.board, { writer: this.writer, base: this.base });
    this.base = this.board;
  }
  read(): void {
    const now = this.store.getObjects(this.repo);
    this.board = rebaseBoard(this.base, this.board, now);
    this.base = now;
  }
}

/** Three people type 240 steps' worth into one note, the frames between the host and the two
 *  replicas arriving late and interleaved, each window hearing of others' changes at once or
 *  `late`. What each store ends with, what each window shows, and what was typed. */
function typeTogether(seed: number, late: boolean) {
  const rnd = random(seed);
  const host = storeWith(`host-${seed}-${late}`, newSeed());
  host.store.setObjects("/a", [note("")]);
  const pending: Array<Array<() => void>> = [];
  const people = [{ store: host.store, repo: "/a", changes: host.changes }];
  for (const g of [1, 2]) {
    const guest = storeWith(`guest-${seed}-${late}-${g}`);
    const [h, c] = lateChannel(pending);
    const off = h.on((text) => {
      const m = parseSync(text);
      if (m?.t !== "hello") return;
      off();
      serveReplica(host.store, "/a", h, { seen: m.seen, access: "edit", changes: host.changes, writer: `peer:${g}` });
    });
    replicate(guest.store, "hive://w", c, { workspace: "w", changes: guest.changes });
    people.push({ store: guest.store, repo: "hive://w", changes: guest.changes });
  }
  const deliverOne = (): boolean => {
    const waiting = pending.filter((q) => q.length > 0);
    if (!waiting.length) return false;
    waiting[Math.floor(rnd() * waiting.length)]!.shift()!();
    return true;
  };
  // Connected first (the hello and welcome), then everyone types while frames trickle through.
  while (deliverOne());
  const windows = people.map((p, i) => {
    const later: Array<() => void> | null = late ? [] : null;
    if (later) pending.push(later);
    return new Window(p.store, p.repo, `window:${i}`, p.changes, later);
  });
  const typed: string[] = [];
  for (let step = 0; step < 240; step++) {
    if (rnd() < 0.45) {
      const who = Math.floor(rnd() * 3);
      const token = `<${who}.${step}>`;
      typed.push(token);
      windows[who]!.type(token, rnd());
    } else {
      deliverOne();
    }
  }
  while (deliverOne());
  for (const w of windows) w.read();
  return { texts: people.map((p) => textOf(p.store.getObjects(p.repo))), shown: windows.map((w) => textOf(w.board)), typed };
}
const tokensIn = (text: string) => (text.match(/<\d+\.\d+>/g) ?? []).sort();
const charsOf = (texts: string[]) => [...texts.join("")].sort().join("");

test("three people typing in one note, each window hearing of the others at once, end with the same text and every word they typed whole, once", () => {
  for (let seed = 1; seed <= 24; seed++) {
    const { texts, shown, typed } = typeTogether(seed, false);
    expect(new Set(texts).size, `seed ${seed}: ${JSON.stringify(texts)}`).toBe(1);
    expect(shown).toEqual(texts);
    expect(tokensIn(texts[0]!), `seed ${seed}`).toEqual([...typed].sort());
    expect(texts[0]!.replace(/<\d+\.\d+>/g, ""), `seed ${seed}`).toBe("");
  }
}, 120_000);

test("when a window writes before it has heard of others' typing, all three still end with the same text and nobody's keystrokes are lost or doubled", () => {
  for (let seed = 1; seed <= 16; seed++) {
    const { texts, shown, typed } = typeTogether(seed, true);
    expect(new Set(texts).size, `seed ${seed}: ${JSON.stringify(texts)}`).toBe(1);
    expect(shown).toEqual(texts);
    expect(charsOf([texts[0]!]), `seed ${seed}`).toBe(charsOf(typed));
  }
}, 120_000);
