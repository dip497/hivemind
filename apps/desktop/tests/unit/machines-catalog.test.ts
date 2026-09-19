import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Catalog } from "../../src/main/remote/catalog.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hmcat-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const m = (n: number) => ({ id: `m_00000000000${n}`, label: `box${n}`, target: `box${n}`, enabled: true });

test("a machines.json the app cannot read is never overwritten", async () => {
  const file = path.join(dir, "bad.json");
  const c = new Catalog(file);
  await c.mutate(() => [m(1)]);
  const handEdited = JSON.stringify({ version: 1, machines: [{ ...m(1), note: "added by a newer hive" }, m(2)] });
  fs.writeFileSync(file, handEdited);
  await c.reload();
  assert.match(c.error ?? "", /unknown field/);
  await assert.rejects(c.mutate((l) => [...l, m(3)]), /could not be read/);
  assert.equal(fs.readFileSync(file, "utf8"), handEdited);
});

test("edits made at the same time all land", async () => {
  const file = path.join(dir, "race.json");
  const c = new Catalog(file);
  await Promise.all([1, 2, 3, 4].map((n) => c.mutate((l) => [...l, m(n)])));
  const onDisk = (JSON.parse(fs.readFileSync(file, "utf8")) as { machines: { id: string }[] }).machines.map((x) => x.id);
  assert.deepEqual(onDisk.sort(), [1, 2, 3, 4].map((n) => m(n).id).sort());
});

test("an edit that changes nothing does not write", async () => {
  const file = path.join(dir, "same.json");
  const c = new Catalog(file);
  await c.mutate(() => [m(1)]);
  const before = fs.statSync(file).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  await c.mutate((l) => l);
  assert.equal(fs.statSync(file).mtimeMs, before);
});

test("an edit made elsewhere is read before ours is written, and a fixed file lifts the refusal", async () => {
  const file = path.join(dir, "shared.json");
  const c = new Catalog(file);
  await c.mutate(() => [m(1)]);
  // Another process (`hive machine add`) writes while we hold a stale list.
  fs.writeFileSync(file, JSON.stringify({ version: 1, machines: [m(1), m(2)] }));
  await c.mutate((l) => l.map((x) => (x.id === m(1).id ? { ...x, label: "renamed" } : x)));
  const after = (JSON.parse(fs.readFileSync(file, "utf8")) as { machines: { id: string; label: string }[] }).machines;
  assert.deepEqual(after.map((x) => x.id).sort(), [m(1).id, m(2).id].sort(), "their machine survived our edit");
  assert.equal(after.find((x) => x.id === m(1).id)?.label, "renamed");

  fs.writeFileSync(file, "{ not json");
  await assert.rejects(c.mutate((l) => [...l, m(3)]), /could not be read/);
  fs.writeFileSync(file, JSON.stringify({ version: 1, machines: [m(1)] }));
  await c.mutate((l) => [...l, m(3)]);
  assert.equal((JSON.parse(fs.readFileSync(file, "utf8")) as { machines: unknown[] }).machines.length, 2, "edits work again once the file parses");
});
