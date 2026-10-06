// Widgets on the board: a package in the profile's widgets folder is offered in the Board menu,
// placed, run in a worker, drawn from what it renders, and its button reaches its code, which
// keeps state in the workspace.
import { test, expect, _electron as electron } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const COUNTER = `
const draw = () => hive.render({ type: "stack", children: [
  { type: "number", value: (hive.state && hive.state.n) || 0, label: "presses" },
  { type: "button", label: "Press", action: "inc" },
] });
hive.on("start", draw);
hive.on("action", (a) => { if (a === "inc") { hive.setState({ n: ((hive.state && hive.state.n) || 0) + 1 }); draw(); } });
`;

test("a widget is offered, placed, drawn, and its button changes what it keeps", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hm-widget-repo-"));
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), "hm-widget-ud-"));
  execSync("git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: repo });
  fs.mkdirSync(path.join(ud, "widgets", "counter"), { recursive: true });
  fs.writeFileSync(path.join(ud, "widgets", "counter", "widget.json"), JSON.stringify({ name: "Counter" }));
  fs.writeFileSync(path.join(ud, "widgets", "counter", "widget.js"), COUNTER);
  const env = { ...process.env, HIVEMIND_PTY_DAEMON: "0", XDG_CONFIG_HOME: path.join(ud, "config") };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=${ud}`], cwd: repo, env });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".react-flow", { timeout: 30_000 });
    await page.mouse.move(700, 450);
    await page.locator('[data-toolbar-action="board"]').first().click();
    await page.locator('[data-board-choice="widget:counter"]').click();
    const widget = page.locator('[data-board-object="widget"][data-widget="counter"]');
    await expect(widget).toContainText("presses", { timeout: 10_000 });
    await expect(widget).toContainText("0");
    await widget.getByRole("button", { name: "Press" }).click();
    await widget.getByRole("button", { name: "Press" }).click();
    await expect(widget).toContainText("2");
    await expect.poll(async () => {
      const objects = await page.evaluate((r) => window.hive.workspaceObjectsSync(r), repo) as Array<{ kind: string; state?: { n?: number } }>;
      return objects.find((o) => o.kind === "widget")?.state?.n;
    }, { timeout: 10_000 }).toBe(2);
  } finally {
    await app.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(ud, { recursive: true, force: true });
  }
});
