// Starting an agent on the phone page (docs/design/phone-browser-2026-10-03.md §11.3), in a
// phone-sized Chromium with no computer: the page's built modules (crates/hive-web/build.sh) served
// from www by route, the computer's answers given by the test. Opened from a project's heading it
// chooses that project's machine and folder, after a reload once the computer is reached; a machine
// that could not be asked says why; a photo too large to send as it is goes as a smaller jpeg.
import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const WWW = path.resolve("../../crates/hive-web/www");
const built = () => fs.existsSync(path.join(WWW, "js", "start.js"));

let browser: Browser | undefined;
test.afterEach(async () => {
  await browser?.close();
  browser = undefined;
});

const claude = { id: "claude", label: "Claude Code", options: [{ id: "mode", label: "Permission mode", values: ["plan", "default"] }, { id: "model", label: "Model", values: [] }] };
const codex = { id: "codex", label: "Codex", options: [] };
/** Where agents may be started in w0, as the computer says it: here, a saved machine, one it could not ask. */
const PLACES = {
  machines: [
    { id: "", name: "desk", programs: [claude, codex], folders: [
      { path: "/home/p/api", name: "api", kind: "project", frame: "f-api" },
      { path: "/home/p/notes", name: "notes", kind: "recent" },
    ] },
    { id: "box1", name: "build-box", programs: [claude], folders: [
      { path: "machine://box1/srv/api", name: "api", kind: "project", frame: "f-box" },
      { path: "machine://box1/srv/web", name: "web", kind: "project", frame: "f-web" },
    ] },
    { id: "zed", name: "Zed", programs: [], folders: [{ path: "machine://zed/code", name: "code", kind: "project", frame: "f-zed" }], unreached: "ssh: connect to host zed: Connection refused" },
  ],
};
const FOLDERS: Record<string, unknown> = {
  "machine://box1/srv/web": { path: "machine://box1/srv/web", folders: [{ name: "app", path: "machine://box1/srv/web/app" }, { name: "docs", path: "machine://box1/srv/web/docs" }], more: true },
  "machine://box1/srv/web/app": { path: "machine://box1/srv/web/app", folders: [] },
};

/** The start screen, with what it asked the computer in `window.calls`; `window.show(workspace, frame)` opens it. */
async function start(): Promise<Page> {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.on("pageerror", (e) => { throw e; });
  await page.route("http://page.test/**", (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (name === "index.html") {
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="app.css"><main id="app"></main>
<script type="module">
import { StartScreen } from "./js/start.js";
import { photoOf } from "./js/photos.js";
const PLACES = ${JSON.stringify(PLACES)};
const FOLDERS = ${JSON.stringify(FOLDERS)};
window.calls = [];
// Reached at once, unless the test says the page reloaded before it was (\`window.unreached\`); then
// \`window.reach()\` reaches it, as the page tells each screen.
const reaching = new Set();
window.reach = () => { window.unreached = false; for (const r of reaching) r(); };
const app = {
  back() {}, computer: () => "desk",
  onReach: (r) => (reaching.add(r), () => reaching.delete(r)),
  workspaces: async () => { if (window.unreached) throw new Error("Still starting"); return [{ workspace: "w0", name: "api" }]; },
  places: async (w) => (window.calls.push(["places", w]), PLACES),
  folders: async (w, f) => (window.calls.push(["folders", w, f]), FOLDERS[f]),
  start: async (w, s) => (window.calls.push(["start", w, s]), "t9"),
  open: (t) => window.calls.push(["open", t]),
};
const screen = new StartScreen(app);
document.getElementById("app").append(screen.el);
window.show = (w, f) => screen.open(w, f);
window.photoOf = photoOf;
window.ready = true;
</script>` });
    }
    const file = path.join(WWW, name);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ contentType: name.endsWith(".css") ? "text/css" : "text/javascript", body: fs.readFileSync(file) });
  });
  await page.goto("http://page.test/index.html");
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
  return page;
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as { calls: unknown[] }).calls);
const chosen = (page: Page, group: string) => page.locator(`[${group}] .chip[aria-pressed="true"]`);

test("opened from a project's heading on a saved machine: that machine, that folder and the one agent found there are chosen; a folder inside it is asked for, and Start asks the computer for exactly that, then opens the new agent", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await start();
  await page.evaluate(() => (window as unknown as { show(w: string, f: string): void }).show("w0", "f-web"));
  await expect(chosen(page, "data-start-machines")).toHaveText(["build-box"]);
  await expect(chosen(page, "data-start-folders")).toHaveText(["web"]);
  await expect(page.locator("[data-start-folder]")).toHaveAttribute("data-start-folder", "machine://box1/srv/web");
  await expect(page.locator("[data-start-programs] .chip")).toHaveText(["Claude Code"]);
  await expect(chosen(page, "data-start-programs")).toHaveText(["Claude Code"]);
  // Inside it: its folders, and that only some are shown; one chosen, then up again and into another.
  await page.locator("[data-start-look]").click();
  await expect(page.locator("[data-start-inside] .chip")).toHaveText(["app", "docs"]);
  await expect(page.locator("[data-start-more]")).toHaveText("The first 2 shown.");
  await page.locator("[data-start-inside] .chip", { hasText: "app" }).click();
  await expect(page.locator("[data-start-folder]")).toHaveText("web / app");
  await page.locator("[data-start-option=\"mode\"] .chip", { hasText: "plan" }).click();
  await page.locator("[data-start-option=\"model\"]").fill("opus");
  await page.locator("[data-start-prompt]").fill("  fix the nav  ");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await page.locator("[data-start-photo-input]").setInputFiles({ name: "screen.png", mimeType: "image/png", buffer: png });
  await expect(page.locator("[data-start-photo]")).toHaveCount(1);
  await page.locator("[data-start-go]").click();
  await expect.poll(() => calls(page)).toEqual([
    ["places", "w0"],
    ["folders", "w0", "machine://box1/srv/web"],
    ["folders", "w0", "machine://box1/srv/web/app"],
    ["start", "w0", { program: "claude", folder: "machine://box1/srv/web/app", prompt: "fix the nav", model: "opus", mode: "plan", images: [{ type: "image/png", data: png.toString("base64") }] }],
    ["open", "t9"],
  ]);
});

test("opened by a reload before the computer is reached, it asks again once it is, for that project; reached again later, what the person chose stays", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await start();
  type Reaching = { unreached: boolean; reach(): void; show(w: string, f: string): Promise<void> };
  await page.evaluate(() => { (window as unknown as Reaching).unreached = true; });
  await page.evaluate(() => (window as unknown as Reaching).show("w0", "f-web"));
  await expect(page.locator("[data-start-error]")).toHaveText("Still starting");
  await page.evaluate(() => (window as unknown as Reaching).reach());
  await expect(page.locator("[data-start-error]")).toHaveCount(0);
  await expect(chosen(page, "data-start-machines")).toHaveText(["build-box"]);
  await expect(chosen(page, "data-start-folders")).toHaveText(["web"]);
  await page.locator("[data-start-prompt]").fill("fix the nav");
  await page.evaluate(() => (window as unknown as Reaching).reach());
  await expect(page.locator("[data-start-prompt]")).toHaveValue("fix the nav");
  expect(await calls(page)).toEqual([["places", "w0"]]);
});

test("a machine that could not be asked says why and offers no agent; a folder opened lately is started in as it is, with nothing inside it offered", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await start();
  await page.evaluate(() => (window as unknown as { show(w: string): void }).show("w0"));
  // With no frame named, this computer and its first project.
  await expect(chosen(page, "data-start-machines")).toHaveText(["desk"]);
  await expect(chosen(page, "data-start-folders")).toHaveText(["api"]);
  await page.locator("[data-start-machines] .chip", { hasText: "Zed" }).click();
  await expect(page.locator("[data-start-unreached]")).toHaveText("Zed could not be asked which agents it has: ssh: connect to host zed: Connection refused");
  await expect(page.locator("[data-start-programs]")).toHaveCount(0);
  await expect(page.locator("[data-start-go]")).toHaveCount(0);
  await page.locator("[data-start-machines] .chip", { hasText: "desk" }).click();
  await page.locator("[data-start-recent] .chip", { hasText: "notes" }).click();
  await expect(chosen(page, "data-start-recent")).toHaveText(["notes"]);
  await expect(page.locator("[data-start-look]")).toHaveCount(0);
  // Two agents here: none is chosen for the person, so Start waits on one.
  await expect(page.locator("[data-start-go]")).toBeDisabled();
  await page.locator("[data-start-programs] .chip", { hasText: "Codex" }).click();
  await page.locator("[data-start-go]").click();
  await expect.poll(() => calls(page)).toEqual([["places", "w0"], ["start", "w0", { program: "codex", folder: "/home/p/notes" }], ["open", "t9"]]);
});

test("a photo larger than 1 MB, or of a type the computer does not take, goes as a jpeg at most 2048 pixels on its longer side; a small png goes as it is", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await start();
  const sent = await page.evaluate(async () => {
    const { photoOf } = window as unknown as { photoOf(b: Blob): Promise<{ type: string; data: string }> };
    const drawn = async (w: number, h: number, type: string) => {
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext("2d")!;
      const noise = g.createImageData(w, h);
      for (let i = 0; i < noise.data.length; i++) noise.data[i] = (i * 2654435761) >>> 24;
      g.putImageData(noise, 0, 0);
      return c.convertToBlob({ type });
    };
    const size = async (p: { type: string; data: string }) => {
      const bytes = Uint8Array.from(atob(p.data), (ch) => ch.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes], { type: p.type }));
      // The bytes' own signature, not only the type it is said to be.
      return { type: p.type, signature: p.data.slice(0, 4), width: image.width, height: image.height };
    };
    const large = await drawn(3000, 1000, "image/png");
    const small = await drawn(20, 10, "image/png");
    const bmp = new Blob([await (await drawn(30, 60, "image/png")).arrayBuffer()], { type: "image/bmp" });
    const asIs = await photoOf(small);
    return {
      large: { bytes: large.size, ...(await size(await photoOf(large))) },
      small: { ...(await size(asIs)), same: asIs.data === btoa(String.fromCharCode(...new Uint8Array(await small.arrayBuffer()))) },
      bmp: await size(await photoOf(bmp)),
    };
  });
  expect(sent.large.bytes).toBeGreaterThan(1024 * 1024);
  expect(sent).toEqual({
    large: { bytes: sent.large.bytes, type: "image/jpeg", signature: "/9j/", width: 2048, height: 683 },
    small: { type: "image/png", signature: "iVBO", width: 20, height: 10, same: true },
    bmp: { type: "image/jpeg", signature: "/9j/", width: 30, height: 60 },
  });
});
