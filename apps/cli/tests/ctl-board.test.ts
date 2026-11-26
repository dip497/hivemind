/** `hive ctl board`, `draw`, `erase` and `page` as an agent runs them, each call its own process, on a
 *  REAL drive socket over the host's own board domain and a real workspace store: undo takes back the
 *  agent's last change across calls, a lock holds against erase, align, duplicate and stacking change
 *  the board, pages are made, nested, drawn in, read and checked one at a time, and every refusal
 *  exits with its code and says what to do. */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceStore, type WorkspaceChange } from "@hivemind/workspace-host/store";
import { spawn } from "node:child_process";
import { newSeed } from "@hivemind/workspace-host/identity";
import { WorkspaceServer } from "@hivemind/workspace-api/server";
import { tileToken } from "@hivemind/agent-host/hooks/token";
import { serveDrive, type DriveServer } from "@hivemind/host/drive";
import { Grants } from "@hivemind/host/grants";
import { board } from "@hivemind/host/board";
import { BoardImages } from "@hivemind/host/board-images";
import { cmd, hiveAsync as hive, sealedEnv } from "./helpers.js";
import { fixtureXDG } from "./agents-fixtures.js";

const unix = process.platform !== "win32";
// Each test runs the CLI as a process dozens of times: on a busy machine that is a minute or more.
setDefaultTimeout(150_000);
// sun_path is ~108 bytes; os.tmpdir() can be deep, /tmp is not.
const dir = unix ? fs.realpathSync(fs.mkdtempSync("/tmp/hive-ctl-board-")) : "";
const sock = path.join(dir, "drive.sock");
const repo = path.join(dir, "repo");
const TOKEN = "t0k3n";
const xdg = fixtureXDG(["claude"]);
const env = { XDG_CONFIG_HOME: xdg, HIVE_DRIVE_SOCK: sock, HCP_TOKEN: tileToken(TOKEN, "hm:me-1") };
/** The page each `page.open` asked the window to show. */
const opened: Array<string | null> = [];
let drive: DriveServer;
const heard = new Set<(c: WorkspaceChange) => void>();

const ctl = (args: string[]) => hive(["ctl", ...args, "--json"], { env });
let asked = 0;
/** Draw `what`, from a file: this suite's server runs in this process, so the CLI runs beside it. */
const drawJson = (what: unknown, ...flags: string[]) => {
  const file = path.join(dir, `draw-${++asked}.json`);
  fs.writeFileSync(file, JSON.stringify(what));
  return ctl(["draw", "--file", file, ...flags]);
};
type Reading = { drawings: Array<{ id: string; box: { x: number } }>; full?: Array<{ id: string; x: number; y: number; z?: number; locked?: boolean }> };
const read = async (...flags: string[]) => (await ctl(["board", ...flags])).json as Reading;

beforeAll(async () => {
  fs.mkdirSync(repo, { recursive: true });
  const store = new WorkspaceStore({ dir: path.join(dir, "store"), person: newSeed(), onChange: (c) => { for (const l of heard) l(c); } });
  // The agent's tile in a frame, as the window lays it out.
  store.setCore(repo, {
    frames: [{ id: "f1", title: "api", x: 100, y: 100, w: 1300, h: 900 } as never],
    tiles: [{ id: "me-1", kind: "claude", label: "claude" }],
    tileNames: {}, editorTabs: {}, frameOf: { "me-1": "f1" },
  });
  store.setView(repo, "canvas", { v: 1, data: { positions: { "me-1": { x: 120, y: 160 } }, sizes: { "me-1": { width: 800, height: 600 } } } });
  const domain = board({
    store: () => store, openPage: async (_repo, page) => { opened.push(page); }, changes: (l) => { heard.add(l); return () => { heard.delete(l); }; },
    images: new BoardImages({ dir: path.join(dir, "board-images") }),
  });
  const server = new WorkspaceServer([domain], new Intents(new AuditLog({ file: path.join(dir, "audit.jsonl") })));
  drive = serveDrive(sock, {
    server, installToken: () => TOKEN, grants: new Grants(path.join(dir, "grants.json")), repos: () => [repo],
    workspaceOf: (tile) => (String(tile).endsWith("me-1") ? repo : null), nameOf: () => "me",
  });
  while (!fs.existsSync(sock)) await new Promise((r) => setTimeout(r, 10));
});
afterAll(() => {
  drive?.close();
  if (unix) fs.rmSync(dir, { recursive: true, force: true });
});

const FLOW = { title: "Flow", boxes: [{ id: "a", text: "Alpha" }, { id: "b", text: "Beta" }], links: [["a", "b"]] };

describe.skipIf(!unix)("hive ctl board, draw, erase and page", () => {
  test("undo takes back the agent's own last change, made by another call; redo puts it back; with nothing left it is refused with a fix", async () => {
    const drawn = (await drawJson(FLOW)).json as { drawing: string };
    expect((await read()).drawings.map((d) => d.id)).toContain(drawn.drawing);

    expect(await ctl(["board", "undo"])).toMatchObject({ code: 0, json: { undone: true } });
    expect((await read()).drawings.map((d) => d.id)).not.toContain(drawn.drawing);
    expect(await ctl(["board", "redo"])).toMatchObject({ code: 0, json: { redone: true } });
    expect((await read()).drawings.map((d) => d.id)).toContain(drawn.drawing);

    expect((await ctl(["board", "undo"])).code).toBe(0);
    const none = await hive(["ctl", "board", "undo"], { env });
    expect(none.code).toBe(7);
    expect(none.stderr).toContain("error [NOTHING_TO_UNDO]");
    expect(none.stderr).toMatch(/\nfix: .+/);
  });

  test("a lock holds against erase until unlocked; duplicate, align and front change the board as asked", async () => {
    const { drawing, boxes } = (await drawJson(FLOW)).json as { drawing: string; boxes: Record<string, string> };
    const [a, b] = [boxes.a!, boxes.b!];

    expect(await ctl(["board", "lock", a])).toMatchObject({ code: 0, json: { changed: [a] } });
    const refused = await ctl(["erase", a]);
    expect(refused).toMatchObject({ code: 6, json: { error: { code: "FORBIDDEN" } } });
    expect((refused.json as { error: { fix?: string } }).error.fix).toBeTruthy();
    expect(await hive(["ctl", "board", "unlock", a], { env })).toMatchObject({ code: 0, stdout: `unlocked: ${a}\n` });

    const copied = (await hive(["ctl", "board", "duplicate", a, "--by=-30,40", "--json"], { env })).json as { copies: string[] };
    expect(copied.copies).toHaveLength(1);
    const [original, copy] = (await read("--ids", `${a},${copied.copies[0]}`)).full!;
    expect({ dx: copy!.x - original!.x, dy: copy!.y - original!.y }).toEqual({ dx: -30, dy: 40 });

    const [apartA, apartB] = (await read("--ids", `${a},${b}`)).full!;
    expect(apartA!.x).not.toBe(apartB!.x);
    expect((await ctl(["board", "align", `${a},${b}`, "--how", "left"])).code).toBe(0);
    const [lineA, lineB] = (await read("--ids", `${a},${b}`)).full!;
    expect(lineA!.x).toBe(lineB!.x);
    expect(await ctl(["board", "align", a, "--how", "sideways"])).toMatchObject({ code: 2, json: { error: { code: "BAD_REQUEST" } } });

    const zOf = (all: Reading["full"], id: string) => all!.find((o) => o.id === id)!.z ?? 0;
    const before = (await read("--ids", `${a},${b}`)).full;
    expect(zOf(before, a)).toBeLessThan(zOf(before, b));
    expect((await ctl(["board", "front", a])).code).toBe(0);
    const stacked = (await read("--ids", `${a},${b}`)).full;
    expect(zOf(stacked, a)).toBeGreaterThan(zOf(stacked, b));

    expect((await ctl(["erase", "--drawing", drawing])).code).toBe(0);
  });

  test("pages: made and nested, drawn in with --page, read and checked inside a page at any depth, top out of every page, gone inside in the window", async () => {
    const payments = ((await ctl(["page", "new", "Payments"])).json as { id: string }).id;
    const checkout = ((await ctl(["page", "new", "Checkout", "--in", payments])).json as { id: string }).id;
    expect(((await ctl(["page", "list"])).json as { pages: unknown[] }).pages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: payments, title: "Payments", parent: null }),
      expect.objectContaining({ id: checkout, title: "Checkout", parent: payments }),
    ]));

    // A box too small to read, drawn inside Payments: its check and the whole canvas's find it, Checkout's not.
    const inside = (await drawJson({ title: "Tiny", boxes: [{ id: "a", text: "Card" }], shapes: [{ form: "rect", x: 0, y: 0, w: 4, h: 4 }] }, "--page", payments)).json as { drawing: string; boxes: Record<string, string> };
    expect((await read("--page", payments)).drawings.map((d) => d.id)).toContain(inside.drawing);
    expect((await read()).drawings.map((d) => d.id)).toContain(inside.drawing);
    const checked = await ctl(["board", "--check", "--page", payments]);
    expect(checked.code).toBe(10);
    expect((checked.json as { problems: Array<{ fix: string }> }).problems.length).toBeGreaterThan(0);
    expect(await ctl(["board", "--check", "--page", checkout])).toMatchObject({ code: 0, json: { problems: [] } });

    // Drawn beside something in Payments: left out, it goes in that page; --page top, in no page.
    const near = inside.boxes.a!;
    const besideIt = ((await drawJson({ boxes: [{ id: "x", text: "X" }] }, "--near", near)).json as { drawing: string }).drawing;
    expect((await read("--page", payments)).drawings.map((d) => d.id)).toContain(besideIt);
    const onTop = ((await drawJson({ boxes: [{ id: "y", text: "Y" }] }, "--near", near, "--page", "top")).json as { drawing: string }).drawing;
    expect((await read()).drawings.map((d) => d.id)).toContain(onTop);
    expect((await read("--page", payments)).drawings.map((d) => d.id)).not.toContain(onTop);

    // Moved into a page and back out of it.
    const loose = ((await drawJson({ title: "Loose", boxes: [{ id: "z", text: "Z" }] }, "--page", "top")).json as { boxes: Record<string, string> }).boxes.z!;
    const idsOn = async (...flags: string[]) => ((await ctl(["board", ...flags])).json as { objects: Array<{ id: string }> }).objects.map((o) => o.id);
    expect((await ctl(["board", "move", loose, "--page", checkout])).code).toBe(0);
    expect(await idsOn("--page", checkout)).toContain(loose);
    expect(await idsOn("--page", payments)).toContain(loose);
    expect((await ctl(["board", "move", loose, "--page", "top"])).code).toBe(0);
    expect(await idsOn()).toContain(loose);
    expect(await idsOn("--page", payments)).not.toContain(loose);
    expect(await ctl(["board", "lock", loose, "--page", checkout])).toMatchObject({ code: 2, json: { error: { code: "USAGE" } } });

    // Erase all it drew, on one page only: what it drew elsewhere stays.
    const inCheckout = ((await drawJson({ title: "Pay", boxes: [{ id: "p", text: "Pay" }] }, "--page", checkout)).json as { drawing: string }).drawing;
    expect((await ctl(["erase", "--mine", "--page", checkout])).code).toBe(0);
    expect((await read("--page", checkout)).drawings.map((d) => d.id)).not.toContain(inCheckout);
    expect((await read()).drawings.map((d) => d.id)).toContain(onTop);
    expect((await read("--page", payments)).drawings.map((d) => d.id)).toContain(besideIt);


    expect(await ctl(["page", "open", checkout])).toMatchObject({ code: 0, json: { opened: checkout } });
    expect(await ctl(["page", "open", "top"])).toMatchObject({ code: 0, json: { opened: null } });
    expect(opened).toEqual([checkout, null]);
    const missing = await hive(["ctl", "page", "open", "frame-nothing"], { env });
    expect(missing.code).toBe(5);
    expect(missing.stderr).toContain("fix: `hive ctl board --json` lists what is drawn, `hive ctl page list` the pages");
  });

  test("a drawing printed as text and sent back with --update changes nothing; an edit of that text keeps the rest where it is", async () => {
    const { drawing, boxes } = (await drawJson(FLOW)).json as { drawing: string; boxes: Record<string, string> };
    const printed = await hive(["ctl", "board", "--drawing", drawing, "--as", "text"], { env });
    expect(printed.code).toBe(0);
    expect(printed.stdout).toBe("title Flow\na[Alpha]\nb[Beta]\na --> b\n");
    const file = path.join(dir, "flow.txt");
    fs.writeFileSync(file, printed.stdout);
    expect(await ctl(["draw", "--update", drawing, "--text", file])).toMatchObject({ code: 0, json: { drawing, added: [], changed: [], erased: [] } });
    fs.writeFileSync(file, printed.stdout.replace("b[Beta]", "b[Beta two]"));
    expect(await ctl(["draw", "--update", drawing, "--text", file])).toMatchObject({ code: 0, json: { changed: [boxes.b], added: [], erased: [] } });
  });

  test("board changes says what changed and who; --follow prints each as it comes until Ctrl+C", async () => {
    const { seq } = (await ctl(["board", "changes"])).json as { seq: number };
    const follower = spawn(...cmd(["ctl", "board", "changes", "--since", String(seq), "--follow", "--json"]), { env: { ...sealedEnv(), ...env } });
    let out = "";
    follower.stdout.on("data", (b) => { out += String(b); });
    const exited = new Promise<number | null>((r) => follower.on("exit", (code) => r(code)));
    const drawn = (await drawJson({ boxes: [{ id: "f", text: "Followed" }] })).json as { boxes: Record<string, string> };
    for (let i = 0; i < 300 && !out.includes(drawn.boxes.f!); i++) await new Promise((r) => setTimeout(r, 50));
    expect(JSON.parse(out.trim().split("\n")[0]!)).toMatchObject({ seq: seq + 1, by: "agent", who: "me-1", objects: [drawn.boxes.f] });
    follower.kill("SIGINT");
    expect(await exited).toBe(0);
    expect(await ctl(["board", "changes", "--since", String(seq)])).toMatchObject({ code: 0, json: { changes: [{ seq: seq + 1, by: "agent" }] } });
  });
  test("draw --image puts a picture on the board at its shape, a drawing's box names one by file, board lists it by hash and alt, and an SVG is refused", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    png.writeUInt32BE(1280, 16);
    png.writeUInt32BE(1600, 20);
    const shot = path.join(dir, "shot.png");
    fs.writeFileSync(shot, png);
    const put = await ctl(["draw", "--image", shot, "--alt", "the sign-in page", "--at", "3000,40"]);
    expect(put.code).toBe(0);
    const { boxes, image } = put.json as { boxes: Record<string, string>; image: { hash: string; width: number; height: number } };
    expect(image).toMatchObject({ width: 1280, height: 1600, type: "image/png" });
    const listed = (await ctl(["board", "--ids", boxes.image!])).json as { objects: unknown[]; full: Array<Record<string, unknown>> };
    // No more than 640 on its long side, at its own shape, where it was asked.
    expect(listed.full[0]).toMatchObject({ form: "image", x: 3000, y: 40, w: 512, h: 640, alt: "the sign-in page", image: { hash: image.hash } });
    expect(listed.objects).toContainEqual(expect.objectContaining({ id: boxes.image, image: image.hash, text: "the sign-in page" }));

    const wide = await ctl(["draw", "--image", shot, "--width", "200", "--at", "3000,800"]);
    expect(((await ctl(["board", "--ids", (wide.json as { boxes: Record<string, string> }).boxes.image!])).json as { full: Array<{ w: number; h: number }> }).full[0]).toMatchObject({ w: 200, h: 250 });

    const flow = (await drawJson({ boxes: [{ id: "page", image: shot, alt: "sign-in" }, { id: "api", text: "API" }], links: [["page", "api"]] })).json as { drawing: string };
    const text = (await ctl(["board", "--drawing", flow.drawing, "--as", "text"])).json as { text: string };
    expect(text.text).toContain(`image page ${image.hash}: sign-in`);

    fs.writeFileSync(path.join(dir, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const svg = await hive(["ctl", "draw", "--image", path.join(dir, "logo.svg")], { env });
    expect(svg.code).not.toBe(0);
    expect(svg.stderr).toContain("PNG, JPEG, WebP or GIF");
  });
});
