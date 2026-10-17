// What one edit costs at 50, 800 and 5000 board objects (docs/design/workspace-sync-2026-10-17.md):
// a typed character written by a window (with the disk write), another window's read of what
// changed, a guest's typed character checked and taken by the host, and a new guest's welcome.
// `bun bench/sync.bench.ts [packages dir]`: another checkout's packages give its numbers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dir, "..", ".."));
const { WorkspaceStore } = await import(path.join(root, "workspace-host/src/store.ts"));
const { newSeed } = await import(path.join(root, "workspace-host/src/identity.ts"));
const { refusedEdit } = await import(path.join(root, "workspace-host/src/edit-rules.ts"));
const edits = fs.existsSync(path.join(root, "workspace-doc/src/board-edit.ts"));
const { boardEdit } = edits ? await import(path.join(root, "workspace-doc/src/board-edit.ts")) : { boardEdit: null };

type Note = { id: string; kind: string; widget: string; placement: string; x: number; y: number; w: number; h: number; text: string };
const median = (xs: number[]): string => [...xs].sort((a, b) => a - b)[xs.length >> 1]!.toFixed(2);
const note = (i: number, text: string): Note => ({ id: `n${String(i).padStart(5, "0")}`, kind: "widget", widget: "note", placement: "board", x: i, y: i, w: 200, h: 160, text });

/** Write `next`, made from `base`, as the store of this checkout takes a window's board. */
function write(store: InstanceType<typeof WorkspaceStore>, repo: string, base: Note[], next: Note[], writer: string): void {
  if (edits) store.editObjects(repo, boardEdit(base, next), { writer });
  else store.setObjects(repo, next, { writer, base });
}
/** Read what changed, as another window does on hearing of it. */
function reread(store: InstanceType<typeof WorkspaceStore>, repo: string, id: string): void {
  if (edits) store.getObjectsWithIds(repo, [id]);
  else store.getObjects(repo);
}

const person = newSeed();
const runs = Number(process.env.RUNS ?? 30);
console.log(`${root} · load ${os.loadavg()[0]!.toFixed(0)} on ${os.cpus().length} CPUs · ${edits ? "edits" : "whole boards"}`);
for (const n of (process.env.SIZES ?? "50,800,5000").split(",").map(Number)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-bench-"));
  const host = new WorkspaceStore({ dir, person });
  host.setCore("/r", { frames: [{ id: "f", title: "r" }], tiles: Array.from({ length: 16 }, (_, i) => ({ id: `t${i}`, kind: "claude" })) });
  let board = Array.from({ length: n }, (_, i) => note(i, `note number ${i} with some words in it`));
  write(host, "/r", [], board, "window");
  const typed: number[] = [];
  const read: number[] = [];
  for (let k = 0; k < runs; k++) {
    const next = board.map((o, i) => (i === 5 ? { ...o, text: o.text + String(k % 10) } : o));
    let t = performance.now();
    write(host, "/r", board, next, "window");
    typed.push(performance.now() - t);
    board = next;
    t = performance.now();
    reread(host, "/r", board[5]!.id);
    read.push(performance.now() - t);
  }
  const guest = new WorkspaceStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "sync-bench-guest-")) });
  guest.importFrom("/g", host.exportSince("/r", null));
  let guestBoard = guest.getObjects("/g") as Note[];
  const taken: number[] = [];
  for (let k = 0; k < runs; k++) {
    const seen = guest.version("/g");
    const next = guestBoard.map((o, i) => (i === 7 ? { ...o, text: o.text + "g" } : o));
    write(guest, "/g", guestBoard, next, "guest window");
    guestBoard = next;
    const update = guest.exportSince("/g", seen);
    const t = performance.now();
    host.importFrom("/r", update, { writer: "peer" }, (before: unknown, after: unknown) => refusedEdit(before as never, after as never, "edit"));
    taken.push(performance.now() - t);
  }
  const welcome = (typeof host.welcomeFor === "function" ? host.welcomeFor("/r", null) : host.exportSince("/r", null)).length;
  console.log(`${String(n).padStart(5)} objects: typed character ${median(typed)} ms · other window's read ${median(read)} ms · guest's character taken ${median(taken)} ms · welcome ${(welcome / 1024).toFixed(1)} KB`);
  fs.rmSync(dir, { recursive: true, force: true });
}
