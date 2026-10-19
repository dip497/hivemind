// Settings → Plugins: one row of controls (yours or HiveHub's, a search, a kind), then a group per
// kind with one heading and its count, rows that all have the same parts with their state in one
// badge and what HiveHub says the plugin does (or nothing), and what a kind does by itself (adding
// agents found on this machine) under its list.
import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PUBLISHED_AGENTS, seedAgents } from "./helpers/agents";
import { buildRegistry } from "./helpers/registry";

let app: ElectronApplication;
let page: Page;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-plugins-page-"));
const xdg = path.join(root, "config");
const bin = path.join(root, "bin");

test.beforeAll(async () => {
  seedAgents(xdg);
  fs.mkdirSync(bin);
  // Claude's CLI is here, so it is the default; nothing else is, so the rest say so.
  fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\n[ \"$1\" = --version ] && { echo '2.0.0 (Claude Code)'; exit 0; }\nexec sleep 60\n", { mode: 0o755 });
  // Pi is ready too, and HiveHub does not list it: nothing says what it does.
  fs.writeFileSync(path.join(bin, "pi"), "#!/bin/sh\n[ \"$1\" = --version ] && { echo '1.0.0'; exit 0; }\nexec sleep 60\n", { mode: 0o755 });
  const hub = buildRegistry(path.join(root, "registry"));
  // HiveHub lists Claude, with what it does; its manifest says nothing.
  hub.add({ id: "claude", type: "agent", name: "Claude", bin: "claude", files: { "agent.yaml": fs.readFileSync(path.join(PUBLISHED_AGENTS, "claude", "agent.yaml"), "utf8") } });
  execFileSync("git", ["init", "-q", path.join(root, "repo")]);
  const env = {
    ...process.env, XDG_CONFIG_HOME: xdg, PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    HIVEMIND_SHELL_ENV: "0", HIVEMIND_PLUGIN_INDEX: hub.indexUrl,
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox"], cwd: path.join(root, "repo"), env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "plugins" } })));
  await expect(page.locator("[data-plugins-home]")).toBeVisible();
});

test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

const body = () => page.locator("[data-settings-body]");
const show = (scope: "Installed" | "HiveHub") => body().getByRole("tab", { name: scope, exact: true }).click();

/** Each group's heading, and how many rows it has. */
async function groups(): Promise<{ heading: string[]; rows: number }[]> {
  return body().locator("[data-plugins-kind]").evaluateAll((sections) => sections.map((s) => ({
    heading: [...s.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]")].map((h) => h.textContent!.trim()),
    rows: s.querySelectorAll("[data-plugin-row]").length,
  })));
}

/** What each row has besides the part that opens it and its chevron: its name, line and state. */
async function rows(where: Locator): Promise<{ id: string; name: number; line: number; said: string[]; extra: string[] }[]> {
  return where.locator("[data-plugin-row]").evaluateAll((all) => all.map((r) => ({
    id: r.getAttribute("data-plugin-row")!,
    name: r.querySelectorAll(".plugin-row-name").length,
    line: r.querySelectorAll(".plugin-row-detail").length,
    said: [...r.querySelectorAll(".plugin-row-name, .plugin-row-detail")].map((e) => e.textContent!),
    extra: [...r.children].filter((c) => !c.hasAttribute("data-plugin-open") && c.tagName.toLowerCase() !== "svg")
      .map((c) => c.getAttribute("data-slot") === "badge" ? `badge:${c.textContent}` : `${c.tagName.toLowerCase()}:${c.getAttribute("role") ?? ""}:${c.textContent}`),
  })));
}

test("one row of controls: yours or HiveHub's, a search and a kind; no second bar of filters, no refresh", async () => {
  for (const scope of ["Installed", "HiveHub"] as const) {
    await show(scope);
    const controls = body().locator("[data-plugins-controls]");
    await expect(controls.getByRole("tablist", { name: "Show" }).getByRole("tab")).toHaveText(["Installed", "HiveHub"]);
    await expect(controls.getByRole("tab", { name: scope, exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(controls.getByRole("searchbox", { name: "Search plugins" })).toBeVisible();
    await expect(controls.getByRole("combobox", { name: "Kind" })).toBeVisible();
    await expect(body().getByRole("tablist")).toHaveCount(1);
    await expect(body().getByRole("group")).toHaveCount(0);
    await expect(body().getByRole("button", { name: /refresh/i })).toHaveCount(0);
  }
  await show("Installed");
});

test("each kind is one heading with its count, and every row has the same parts, its state in one badge", async () => {
  await expect(body().locator('[data-plugin-open="agent:claude"]')).toBeVisible();
  // The catalog arrives after the list: Claude's line is HiveHub's words once it has.
  await expect(body().locator('[data-plugin-row="agent:claude"] .plugin-row-detail')).toHaveText("A test agent from the catalog.");
  const kinds = await groups();
  expect(kinds.map((g) => g.heading)).toEqual(kinds.map((g) => [expect.stringMatching(new RegExp(`^(Agents|Views|Widgets|Tools)${g.rows}$`))]));
  expect(kinds.map((g) => g.heading[0]!.replace(/\d+$/, ""))).toEqual(["Agents", "Views", "Widgets", "Tools"]);

  const installed = await rows(body());
  for (const r of installed) {
    expect(r.name, r.id).toBe(1);
    expect(r.line, r.id).toBeLessThanOrEqual(1);
    expect(new Set(r.said).size, r.id).toBe(r.said.length);
    for (const e of r.extra) expect(e, r.id).toMatch(/^badge:/);
  }
  expect(installed.find((r) => r.id === "agent:pi")?.said).toEqual(["Pi"]);
  const badge = (id: string) => installed.find((r) => r.id === id)?.extra;
  expect(badge("agent:claude")).toEqual(["badge:Default"]);
  // Installed, its program missing: not "Not installed" under Installed.
  expect(badge("agent:codex")).toEqual(["badge:Needs setup"]);
  expect(badge("view:canvas")).toEqual(["badge:In use"]);
  expect(badge("tool:@hivemind/web")).toEqual(["badge:Off"]);
  expect(badge("tool:@hivemind/code")).toEqual([]);
  await expect(body().locator("[data-plugin-row]").filter({ hasText: "worker" })).toHaveCount(0);

  await show("HiveHub");
  await expect(body().locator("[data-plugin-row]").first()).toBeVisible();
  const hub = await rows(body());
  for (const r of hub) {
    expect(r.extra, r.id).toEqual([expect.stringMatching(/^badge:Installed$|^button::(Install|Update)$/)]);
    // A description that only repeats the name (the catalog's agents and views here) is not shown.
    expect(r, r.id).toMatchObject(/^(agent|view):/.test(r.id) && r.id !== "agent:claude" ? { name: 1, line: 0 } : { name: 1, line: 1 });
    expect(new Set(r.said).size, r.id).toBe(r.said.length);
  }
  expect(hub.filter((r) => r.line === 0).length).toBeGreaterThan(0);
  for (const g of await groups()) expect(g.heading).toEqual([expect.stringMatching(new RegExp(`^(Agents|Views|Widgets|Tools)${g.rows}$`))]);
  await show("Installed");
});

test("adding agents found on this machine is under the Agents list, not among its rows, and saves", async () => {
  const agents = body().locator('[data-plugins-kind="agent"]');
  const auto = agents.locator(".plugins-group-foot").getByRole("switch", { name: "Add agents found on this machine" });
  await expect(auto).toBeVisible();
  await expect(agents.locator(".plugin-rows").getByRole("switch")).toHaveCount(0);
  const saved = () => page.evaluate(() => window.hive.settingsSync().agents.autoInstall);
  const before = await saved();
  await auto.click();
  await expect.poll(saved).toBe(!before);
  await expect(auto).toHaveAttribute("aria-checked", String(!before));
  await auto.click();
  await expect.poll(saved).toBe(before);
});
