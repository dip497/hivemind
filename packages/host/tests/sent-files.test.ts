// Files an agent sends the person's phone (sent-files.ts, spec/sent-files.md): frozen when sent,
// fetched in pieces by id, told to whoever follows the agent's list, and gone when too old, too many
// or taken back. A guest and a phone's other asks are peer-links.test.ts's.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import type { EventMessage } from "@hivemind/workspace-api/protocol";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import type { Actor } from "@hivemind/workspace-host/intents";
import { SENT_FILE_MAX, SENT_FILE_PIECE, SENT_FILE_KEPT_DAYS, SENT_FILES_PER_AGENT, SentFileStore, sentFileName, sentFiles } from "../src/sent-files.ts";
import type { SentFile } from "@hivemind/workspace-api/agents";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-sent-files-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let made = 0;

function setup(opts: { phones?: number; now?: () => number } = {}) {
  const dir = path.join(tmp, String(made++));
  fs.mkdirSync(dir);
  const folder = path.join(dir, "kept");
  const now = opts.now ?? Date.now;
  const store = new SentFileStore(folder, now);
  const domain = sentFiles({
    store,
    place: (tile) => (tile === "t1" || tile === "t2" ? "/work" : tile === "far" ? "ssh://box/work" : null),
    elsewhere: (place) => place.startsWith("ssh://"),
    phones: () => opts.phones ?? 1,
  });
  const server = new WorkspaceServer([domain], new Intents(new AuditLog({ file: path.join(dir, "audit.jsonl") })));
  const client = (actor: Actor = { kind: "person" }) => {
    const closing = new AbortController();
    const got: EventMessage[] = [];
    const c: Connection & { got: EventMessage[]; go(): void } = { actor, got, send: (m) => got.push(m), closed: closing.signal, go: () => closing.abort() };
    server.connect(c);
    return c;
  };
  const make = (name: string, bytes: Buffer | string) => {
    const at = path.join(dir, name);
    fs.writeFileSync(at, bytes);
    return at;
  };
  return { dir, folder, store, server, client, make };
}
const result = <T>(a: unknown): T => {
  assert.ok(a && typeof a === "object" && "result" in a, `refused: ${JSON.stringify(a)}`);
  return (a as { result: T }).result;
};
const code = (a: unknown) => (a as { error?: { code: string } }).error?.code;
const pattern = (n: number) => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31) & 0xff;
  return b;
};

test("a file sent is frozen when sent: changed or deleted on the computer afterwards, the phone still gets it exactly, in pieces, by its id", async () => {
  const s = setup();
  const bytes = pattern(SENT_FILE_PIECE * 2 + 1234);
  const source = s.make("report.pdf", bytes);
  const sent = result<SentFile>(await s.server.answer("agent.sendFile", ["hm:t1", source], s.client()));
  assert.deepEqual([sent.tile, sent.name, sent.size, sent.type], ["t1", "report.pdf", bytes.length, "application/pdf"]);
  assert.match(sent.id, /^[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(sent).includes(s.dir), "no path on the computer leaves with it");
  fs.writeFileSync(source, "changed");
  fs.rmSync(source);
  const phone = s.client();
  const pieces: Buffer[] = [];
  for (let at = 0; at < bytes.length; ) {
    const r = result<{ data: string; size: number }>(await s.server.answer("agent.filePiece", [sent.id, at], phone));
    assert.equal(r.size, bytes.length);
    const piece = Buffer.from(r.data, "base64");
    assert.ok(piece.length <= SENT_FILE_PIECE);
    pieces.push(piece);
    at += piece.length;
  }
  assert.equal(pieces.length, 3);
  assert.ok(Buffer.concat(pieces).equals(bytes));
});

test("the phone can only name an id: a path or another's id finds nothing, and the copies are readable by this user alone", async () => {
  const s = setup();
  const secret = s.make("secret.txt", "secret");
  const sent = result<SentFile>(await s.server.answer("agent.sendFile", ["t1", s.make("a.txt", "a")], s.client()));
  const phone = s.client();
  for (const id of [secret, "../a.txt", `../${path.basename(secret)}`, "0".repeat(32)]) {
    assert.equal(code(await s.server.answer("agent.filePiece", [id, 0], phone)), "NOT_FOUND", id);
  }
  assert.equal(code(await s.server.answer("agent.filePiece", [sent.id, -1], phone)), "BAD_REQUEST");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(s.folder, sent.id)).mode & 0o077, 0, "the copy");
    assert.equal(fs.statSync(path.join(s.folder, `${sent.id}.json`)).mode & 0o077, 0, "what it is");
    assert.equal(fs.statSync(s.folder).mode & 0o077, 0, "the folder");
  }
});

test("sending is refused, with nothing kept, for a file too big, a folder, a missing file, no phone, a tile with no agent, an agent on another machine, or another agent's tile", async () => {
  const s = setup();
  const person = s.client();
  const big = path.join(s.dir, "big.bin");
  fs.closeSync(fs.openSync(big, "w"));
  fs.truncateSync(big, SENT_FILE_MAX + 1);
  const a = s.make("a.txt", "a");
  assert.equal(code(await s.server.answer("agent.sendFile", ["t1", big], person)), "FILE_TOO_BIG");
  assert.equal(code(await s.server.answer("agent.sendFile", ["t1", s.dir], person)), "BAD_REQUEST");
  assert.equal(code(await s.server.answer("agent.sendFile", ["t1", path.join(s.dir, "none")], person)), "NOT_FOUND");
  assert.equal(code(await s.server.answer("agent.sendFile", ["t1", "a.txt"], person)), "BAD_REQUEST");
  assert.equal(code(await s.server.answer("agent.sendFile", ["t7", a], person)), "NO_AGENT");
  assert.equal(code(await s.server.answer("agent.sendFile", ["far", a], person)), "UNSUPPORTED");
  const agent = s.client({ kind: "peer", person: "p", device: "d", access: "owner", tile: "hm:t1", client: "agent" } as Actor);
  assert.equal(code(await s.server.answer("agent.sendFile", ["t2", a], agent)), "FORBIDDEN");
  const phone = s.client({ kind: "peer", person: "p", device: "d", access: "owner" } as Actor);
  assert.equal(code(await s.server.answer("agent.sendFile", ["t1", a], phone)), "FORBIDDEN");
  assert.equal(code(await s.server.answer("agent.sentFiles", ["t1"], phone)), "FORBIDDEN");
  assert.equal(code(await s.server.answer("agent.takeBackFile", ["0".repeat(32)], phone)), "FORBIDDEN");
  assert.equal(result<SentFile>(await s.server.answer("agent.sendFile", ["t1", a], agent)).tile, "t1");
  assert.equal((await s.store.of("t1")).length, 1);

  const none = setup({ phones: 0 });
  assert.equal(code(await none.server.answer("agent.sendFile", ["t1", none.make("a.txt", "a")], none.client())), "NO_PHONE");
  assert.deepEqual(await none.store.of("t1"), []);
});

test("whoever follows an agent's files is told its whole list as it changes, an agent takes back only its own, and one that has gone is told no more", async () => {
  const s = setup();
  const person = s.client();
  const [phone, otherAgent] = [s.client(), s.client()];
  assert.deepEqual(result(await s.server.answer("agent.files", ["t1"], phone)), { files: [] });
  await s.server.answer("agent.files", ["t2"], otherAgent);
  const sent = result<SentFile>(await s.server.answer("agent.sendFile", ["t1", s.make("a.txt", "a")], person));
  assert.deepEqual(phone.got.map((m) => [m.event, (m.params[1] as SentFile[]).map((f) => f.id)]), [["agent.filesChanged", [sent.id]]]);
  assert.equal(otherAgent.got.length, 0);

  const t2 = s.client({ kind: "peer", person: "p", device: "d", access: "owner", tile: "t2", client: "agent" } as Actor);
  assert.equal(code(await s.server.answer("agent.takeBackFile", [sent.id], t2)), "FORBIDDEN");
  assert.deepEqual(result(await s.server.answer("agent.takeBackFile", [sent.id], person)), { takenBack: true });
  assert.deepEqual(phone.got.at(-1)!.params, ["t1", []]);
  assert.equal(code(await s.server.answer("agent.filePiece", [sent.id, 0], phone)), "NOT_FOUND");
  assert.deepEqual(result(await s.server.answer("agent.takeBackFile", [sent.id], person)), { takenBack: false });
  assert.deepEqual(fs.readdirSync(s.folder), [], "its copy is gone from the disk");

  phone.go();
  await s.server.answer("agent.sendFile", ["t1", s.make("b.txt", "b")], person);
  assert.equal(phone.got.length, 2);
});

test("a file is kept 7 days, an agent's list holds its newest 50, and after a restart what was sent is still there and a half-finished copy is not", async () => {
  let now = 1_800_000_000_000;
  const s = setup({ now: () => now });
  const person = s.client();
  const source = s.make("a.txt", "a");
  const old = result<SentFile>(await s.server.answer("agent.sendFile", ["t2", source], person));
  now += (SENT_FILE_KEPT_DAYS * 24 * 60 * 60 * 1000) - 1;
  assert.equal((await s.store.of("t2")).length, 1);
  now += 1;
  assert.deepEqual(await s.store.of("t2"), []);
  assert.equal(code(await s.server.answer("agent.filePiece", [old.id, 0], person)), "NOT_FOUND");

  const sent: SentFile[] = [];
  for (let i = 0; i < SENT_FILES_PER_AGENT + 2; i++) {
    now += 1;
    sent.push(result<SentFile>(await s.server.answer("agent.sendFile", ["t1", source], person)));
  }
  assert.deepEqual((await s.store.of("t1")).map((f) => f.id), sent.slice(2).map((f) => f.id));
  assert.ok(!fs.existsSync(path.join(s.folder, old.id)), "the file past its time left the disk at the next send");
  assert.ok(!fs.existsSync(path.join(s.folder, sent[0]!.id)), "so did the file past the agent's 50");

  fs.writeFileSync(path.join(s.folder, "abc.going"), "half");
  fs.writeFileSync(path.join(s.folder, "f".repeat(32)), "no record of what it is");
  fs.writeFileSync(path.join(s.folder, `${"e".repeat(32)}.json`), "not json");
  const again = new SentFileStore(s.folder, () => now);
  assert.deepEqual((await again.of("t1")).map((f) => f.id), sent.slice(2).map((f) => f.id));
  assert.equal(Buffer.from((await again.piece(sent.at(-1)!.id, 0)).data, "base64").toString(), "a");
  assert.equal(fs.readdirSync(s.folder).length, SENT_FILES_PER_AGENT * 2);
});

test("a file's name carries no folder and nothing that draws as something else", () => {
  assert.equal(sentFileName("/home/me/report.pdf"), "report.pdf");
  assert.equal(sentFileName("/home/me/in‮fdp.exe"), "infdp.exe");
  assert.equal(sentFileName("/home/me/a\nb.txt"), "ab.txt");
  const long = sentFileName(`/home/${"x".repeat(400)}.pdf`);
  assert.equal(long.length, 200);
  assert.ok(long.endsWith(".pdf"));
});
