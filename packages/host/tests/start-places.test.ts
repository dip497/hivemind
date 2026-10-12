// Where the person may start an agent from their phone (start-places.ts, spec/agents.md 0.8): each
// machine a workspace's projects are on, this computer first, with the agents found there, its
// projects and the folders opened lately; inside a project its folders, and nothing outside one;
// the frame an agent started in a folder runs in, opened when there is none; and photos kept on
// the machine it runs on. This computer's files are real ones; a saved machine's are read from a
// folder standing in for it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentProviderDef } from "@hivemind/agents";
import type { CoreLayout, FrameRecord } from "@hivemind/workspace-doc/shapes";
import { FOLDERS_MAX, IMAGE_BYTES, IMAGES_MAX, StartPlaces, imagesOf, localFs, type MachineFs } from "../src/start-places.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-start-places-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const BOX = "box1";
const DEVICE = "d2".repeat(32);

const agent = (id: string, bin = id) => ({ id, label: id, bin, enabled: true }) as unknown as AgentProviderDef;
const claude = agent("claude");
const codex = agent("codex");
const talker = agent("talker", "talker-agent");

/** A tree of folders under `root`: each name a folder, `name -> target` a link. */
function tree(root: string, names: string[]): string {
  for (const n of names) {
    const [at, to] = n.split(" -> ");
    if (to) fs.symlinkSync(path.join(root, to), path.join(root, at));
    else fs.mkdirSync(path.join(root, at), { recursive: true });
  }
  return root;
}

/** A device holding the workspace at `repo`, whose frames `frames` are; the box's files are under
 *  `box` here, its agents `onBox`. */
function device(o: { frames?: FrameRecord[]; recent?: string[]; onBox?: string[]; boxDown?: boolean } = {}) {
  const repo = tree(fs.mkdtempSync(path.join(tmp, "api-")), ["src/ui", "docs", ".git", "web/app"]);
  const box = tree(fs.mkdtempSync(path.join(tmp, "box-")), ["srv/api/cmd", "srv/api/pkg", "srv/other"]);
  const core: CoreLayout = { frames: o.frames ?? [{ id: "f-api", title: "api", workspacePath: repo }], tiles: [] } as CoreLayout;
  const opened: FrameRecord[] = [];
  const recent = [...(o.recent ?? [])];
  const photos = path.join(tmp, "photos");
  const here = localFs(() => photos);
  const local = (p: string) => path.join(box, p);
  const boxFs: MachineFs = {
    realpath: async (dir) => path.relative(box, await here.realpath(local(dir))).replace(/^/, "/"),
    readdir: (dir) => here.readdir(local(dir)),
    found: async (bins) => bins.filter((b) => (o.onBox ?? []).includes(b)),
    keep: async (name, data) => { fs.mkdirSync(local("photos"), { recursive: true }); fs.writeFileSync(local(`photos/${name}`), data); return `/photos/${name}`; },
  };
  const places = new StartPlaces({
    core: (r) => (r === repo ? core : null),
    repos: () => [repo],
    machines: { self: () => ({ device: "d1".repeat(32), name: "desk" }), mine: () => undefined, whose: () => undefined, saved: (id) => ({ [BOX]: "build-box", zed: "Zed" } as Record<string, string>)[id] },
    agents: () => [claude, codex, talker],
    programs: () => [claude],
    recent: () => recent,
    files: async (m) => {
      if (m === "") return here;
      if (m === BOX && !o.boxDown) return boxFs;
      throw new Error(`ssh: connect to host ${m}: Connection refused`);
    },
    photos: () => photos,
  });
  const frameFor = (folder: string) => places.frameFor(repo, folder, (f) => { opened.push(f); core.frames.push(f); });
  return { repo, box, core, opened, recent, places, frameFor, photos };
}

/** `asked` is refused with `code`, saying `pattern`. */
const refused = (asked: () => Promise<unknown>, code: string, pattern: RegExp) =>
  assert.rejects(asked(), (e: Error & { code?: string }) => e.code === code && pattern.test(e.message));

test("places: this computer first with its agents, the workspace's own folder then each frame's as projects, then the folders opened lately; each saved machine after, by name, with the agents found there", async () => {
  const d = device();
  const elsewhere = tree(fs.mkdtempSync(path.join(tmp, "notes-")), []);
  d.core.frames.push(
    { id: "f-box", title: "on the box", workspacePath: `machine://${BOX}/srv/api` },
    { id: "f-zed", title: "zed", workspacePath: "machine://zed/home/z" },
    { id: "f-dev", title: "phone", workspacePath: `machine://${DEVICE}/x` },
    { id: "f-gone", title: "gone", workspacePath: "machine://gone/x" },
  );
  d.recent.push(elsewhere, d.repo, `machine://${BOX}/srv/other`, `machine://${DEVICE}/y`, "relative/x");
  const got = await d.places.places(d.repo);
  assert.deepEqual(got.machines.map((m) => [m.id, m.name, m.programs.map((p) => p.id)]), [["", "desk", ["claude"]], [BOX, "build-box", []], ["zed", "Zed", []]]);
  assert.deepEqual(got.machines[0].folders, [
    { path: d.repo, name: path.basename(d.repo), kind: "project", frame: "f-api" },
    { path: elsewhere, name: path.basename(elsewhere), kind: "recent" },
  ]);
  assert.deepEqual(got.machines[1].folders, [
    { path: `machine://${BOX}/srv/api`, name: "on the box", kind: "project", frame: "f-box" },
    { path: `machine://${BOX}/srv/other`, name: "other", kind: "recent" },
  ]);
  assert.equal(got.machines[1].unreached, undefined);
  assert.match(got.machines[2].unreached ?? "", /Connection refused/);
});

test("places: the agents found on a saved machine are those switched on whose command it finds", async () => {
  const d = device({ onBox: ["talker-agent", "codex"] });
  d.core.frames.push({ id: "f-box", title: "box", workspacePath: `machine://${BOX}/srv/api` });
  const got = await d.places.places(d.repo);
  assert.deepEqual(got.machines[1].programs.map((p) => p.id), ["codex", "talker"]);
  assert.deepEqual(await d.places.programsAt(`machine://${BOX}/srv/api/cmd`).then((ps) => ps.map((p) => p.id)), ["codex", "talker"]);
  assert.deepEqual(await d.places.programsAt(path.join(d.repo, "src")).then((ps) => ps.map((p) => p.id)), ["claude"]);
  assert.equal(await d.places.installedAt(talker, `machine://${BOX}/srv/api`), true);
  assert.equal(await d.places.installedAt(claude, `machine://${BOX}/srv/api`), false);
  // One of the person's devices is not asked here.
  assert.equal(await d.places.installedAt(claude, `machine://${DEVICE}/x`), true);
});

test("folders: the folders in a project, or inside one, by name; never hidden ones, links or files, and nothing outside a project", async () => {
  const d = device();
  fs.writeFileSync(path.join(d.repo, "README.md"), "x");
  tree(d.repo, ["out -> ../", "docs/guide"]);
  assert.deepEqual(await d.places.folders(d.repo, d.repo), {
    path: d.repo,
    folders: ["docs", "src", "web"].map((name) => ({ name, path: path.join(d.repo, name) })),
  });
  assert.deepEqual((await d.places.folders(d.repo, path.join(d.repo, "src"))).folders, [{ name: "ui", path: path.join(d.repo, "src", "ui") }]);
  await refused(() => d.places.folders(d.repo, path.dirname(d.repo)), "FORBIDDEN", /inside this workspace's projects/);
  await refused(() => d.places.folders(d.repo, path.join(d.repo, "out")), "FORBIDDEN", /inside this workspace's projects/);
  await refused(() => d.places.folders(d.repo, path.join(d.repo, "src/..", "..")), "FORBIDDEN", /inside this workspace's projects/);
  await refused(() => d.places.folders(d.repo, path.join(d.repo, "nope")), "NOT_FOUND", /not a folder there/);
  await refused(() => d.places.folders(d.repo, "docs"), "BAD_REQUEST", /neither here nor on a saved machine/);
  await refused(() => d.places.folders("/elsewhere", d.repo), "NOT_FOUND", /no such workspace/);
});

test("folders: a recent folder is not listed; a saved machine's project is, as machine uris", async () => {
  const notes = tree(fs.mkdtempSync(path.join(tmp, "notes-")), ["a"]);
  const d = device({ recent: [notes] });
  d.core.frames.push({ id: "f-box", title: "box", workspacePath: `machine://${BOX}/srv/api` });
  await refused(() => d.places.folders(d.repo, notes), "FORBIDDEN", /inside this workspace's projects/);
  assert.deepEqual(await d.places.folders(d.repo, `machine://${BOX}/srv/api`), {
    path: `machine://${BOX}/srv/api`,
    folders: [{ name: "cmd", path: `machine://${BOX}/srv/api/cmd` }, { name: "pkg", path: `machine://${BOX}/srv/api/pkg` }],
  });
  await refused(() => d.places.folders(d.repo, `machine://${BOX}/srv`), "FORBIDDEN", /inside this workspace's projects/);
});

test(`folders: at most ${FOLDERS_MAX}, and it says there are more`, async () => {
  const d = device();
  const many = path.join(d.repo, "many");
  for (let i = 0; i <= FOLDERS_MAX; i++) fs.mkdirSync(path.join(many, `d${String(i).padStart(3, "0")}`), { recursive: true });
  const got = await d.places.folders(d.repo, many);
  assert.equal(got.folders.length, FOLDERS_MAX);
  assert.equal(got.folders.at(-1)?.name, `d${String(FOLDERS_MAX - 1).padStart(3, "0")}`);
  assert.equal(got.more, true);
  fs.rmdirSync(path.join(many, `d${FOLDERS_MAX}`));
  assert.equal((await d.places.folders(d.repo, many)).more, undefined);
});

test("the frame an agent started in a folder runs in: the frame there, however the folder is spelled; else one opened inside the innermost project it is in, named by it", async () => {
  const d = device();
  const web = path.join(d.repo, "web");
  d.core.frames.push({ id: "f-web", title: "web", workspacePath: web, parentFrameId: "f-api" });
  fs.symlinkSync(d.repo, path.join(tmp, `alias-${path.basename(d.repo)}`));
  assert.equal(await d.frameFor(d.repo), "f-api");
  assert.equal(await d.frameFor(`${d.repo}/src/..`), "f-api");
  assert.equal(await d.frameFor(path.join(tmp, `alias-${path.basename(d.repo)}`)), "f-api");
  assert.equal(await d.frameFor(web), "f-web");
  assert.deepEqual(d.opened, []);
  const ui = await d.frameFor(path.join(d.repo, "src", "ui"));
  const app = await d.frameFor(path.join(web, "app"));
  assert.deepEqual(d.opened.map(({ id, ...f }) => [id === ui || id === app, f]), [
    [true, { title: "ui", workspacePath: path.join(d.repo, "src", "ui"), parentFrameId: "f-api" }],
    [true, { title: "app", workspacePath: path.join(web, "app"), parentFrameId: "f-web" }],
  ]);
  // Opened once: the next start there runs in it.
  assert.equal(await d.frameFor(path.join(d.repo, "src", "ui")), ui);
  assert.equal(d.opened.length, 2);
});

test("the frame for a folder: at the top for the workspace's own folder with no frame there, or a folder opened lately; a worktree's frame by its folder; nothing anywhere else", async () => {
  const notes = tree(fs.mkdtempSync(path.join(tmp, "notes-")), ["a"]);
  const d = device({ frames: [], recent: [notes, `machine://${BOX}/srv/other`] });
  const own = await d.frameFor(d.repo);
  const docs = await d.frameFor(path.join(d.repo, "docs"));
  assert.deepEqual(d.opened.map(({ id, ...f }) => [id, f]), [
    [own, { title: path.basename(d.repo), workspacePath: d.repo }],
    [docs, { title: "docs", workspacePath: path.join(d.repo, "docs"), parentFrameId: own }],
  ]);
  await refused(() => d.frameFor(path.join(notes, "a")), "FORBIDDEN", /none of this workspace's projects, and not one opened lately/);
  const top = await d.frameFor(notes);
  assert.deepEqual(d.opened.at(-1), { id: top, title: path.basename(notes), workspacePath: notes });
  const other = await d.frameFor(`machine://${BOX}/srv/other`);
  assert.deepEqual(d.opened.at(-1), { id: other, title: "other", workspacePath: `machine://${BOX}/srv/other` });
  // Opened, it is one of the workspace's projects.
  assert.equal(typeof await d.frameFor(path.join(notes, "a")), "string");
  assert.deepEqual(d.opened.at(-1)?.parentFrameId, top);
  await refused(() => d.frameFor(tmp), "FORBIDDEN", /none of this workspace's projects/);
  await refused(() => d.frameFor(`machine://${BOX}/srv/api`), "FORBIDDEN", /none of this workspace's projects/);
  d.core.frames.push({ id: "f-wt", title: "fix", branch: "fix", worktreePath: path.join(d.repo, "web") } as FrameRecord);
  assert.equal(await d.frameFor(path.join(d.repo, "web")), "f-wt");
});

test("photos are kept on the machine the folder is on, under names of their own, bytes intact", async () => {
  const d = device();
  d.core.frames.push({ id: "f-box", title: "box", workspacePath: `machine://${BOX}/srv/api` });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const jpg = Buffer.from([0xff, 0xd8, 0xff]);
  const kept = await d.places.keep(d.repo, [{ type: "image/png", data: png.toString("base64") }, { type: "image/jpeg", data: jpg.toString("base64") }]);
  assert.equal(kept.length, 2);
  assert.match(kept[0], new RegExp(`^${d.photos}/[0-9a-f]{16}\\.png$`));
  assert.match(kept[1], /\.jpg$/);
  assert.notEqual(path.basename(kept[0], ".png"), path.basename(kept[1], ".jpg"));
  assert.deepEqual(fs.readFileSync(kept[0]), png);
  assert.equal(fs.statSync(kept[0]).mode & 0o777, 0o600);
  const there = await d.places.keep(`machine://${BOX}/srv/api`, [{ type: "image/webp", data: png.toString("base64") }]);
  assert.match(there[0], /^\/photos\/[0-9a-f]{16}\.webp$/);
  assert.deepEqual(fs.readFileSync(path.join(d.box, there[0])), png);
});

test(`photos asked for, checked: at most ${IMAGES_MAX}, each a png, jpeg, webp or gif in base64 of at most ${IMAGE_BYTES} bytes`, () => {
  const one = { type: "image/png", data: "iVBORw==" };
  assert.equal(imagesOf(undefined), undefined);
  assert.deepEqual(imagesOf([one]), [one]);
  assert.deepEqual(imagesOf(Array(IMAGES_MAX).fill(one)), Array(IMAGES_MAX).fill(one));
  const big = "A".repeat(Math.ceil(IMAGE_BYTES / 3) * 4);
  assert.equal(imagesOf([{ type: "image/gif", data: big }])?.[0].data.length, big.length);
  for (const [bad, said] of [
    [Array(IMAGES_MAX + 1).fill(one), /at most 4 photos/],
    [one, /at most 4 photos/],
    [[{ type: "image/svg+xml", data: "PHN2Zz4=" }], /png, jpeg, webp or gif/],
    [[{ type: "image/png" }], /png, jpeg, webp or gif/],
    [[null], /png, jpeg, webp or gif/],
    [[{ type: "image/png", data: "not base64!" }], /base64 of at most/],
    [[{ type: "image/png", data: `${big}AAAA` }], /base64 of at most/],
  ] as const) assert.throws(() => imagesOf(bad), (e: Error & { code?: string }) => e.code === "BAD_REQUEST" && said.test(e.message));
});
