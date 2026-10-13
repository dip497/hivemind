// Settings pages were declared in three places — the nav array, an inline switch
// in App.tsx, and the switch in the lazy chunk — with nothing checking they
// agreed. A page present in the nav but missing a renderer showed an EMPTY body
// and said nothing. These lock the two halves together.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "renderer", "src");

const { SETTINGS_NAV, SETTINGS_PAGES, SETTINGS_PAGE_IDS, PLUGIN_PAGE_KINDS, pluginPage, resolveSettingsPage, settingsPage } = await import("../../src/renderer/src/settings-registry.ts");

/** Ids the lazy chunk claims, read from source so the test cannot drift by import. */
function lazyClaims(): string[] {
  const src = readFileSync(join(SRC, "settings-panels.tsx"), "utf8");
  const m = src.match(/export const LAZY_SETTINGS_PAGES = \[([^\]]+)\]/);
  assert.ok(m, "LAZY_SETTINGS_PAGES not found in settings-panels.tsx");
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

/** Ids App.tsx renders itself, as `page === "x"` guards. */
function eagerClaims(): string[] {
  const src = readFileSync(join(SRC, "App.tsx"), "utf8");
  return [...new Set([...src.matchAll(/page === "([a-z]+)"/g)].map((x) => x[1]!))];
}

test("every page in the nav has exactly one renderer", () => {
  const lazy = new Set(lazyClaims());
  const eager = new Set(eagerClaims());
  for (const id of SETTINGS_PAGE_IDS) {
    const renderers = [lazy.has(id) && "lazy", eager.has(id) && "eager"].filter(Boolean);
    assert.ok(renderers.length >= 1, `settings page "${id}" is in the nav but nothing renders it`);
  }
});

test("no renderer claims a page that is not in the nav", () => {
  for (const id of lazyClaims()) {
    assert.ok(SETTINGS_PAGE_IDS.includes(id as never), `the lazy chunk renders "${id}", which is not a nav page`);
  }
});

test("the registry's chunk split matches who actually renders each page", () => {
  const lazy = new Set(lazyClaims());
  for (const p of SETTINGS_PAGES) {
    if (p.chunk === "lazy") {
      assert.ok(lazy.has(p.id), `"${p.id}" is marked lazy but the Settings chunk does not render it`);
    } else {
      assert.ok(!lazy.has(p.id), `"${p.id}" is marked eager but the lazy chunk also claims it`);
    }
  }
});

test("page ids are unique, and every page carries the fields the nav renders", () => {
  assert.equal(new Set(SETTINGS_PAGE_IDS).size, SETTINGS_PAGE_IDS.length, "duplicate settings page id");
  for (const p of SETTINGS_PAGES) {
    assert.ok(p.label.length > 0, `${p.id} has no label`);
    assert.ok(p.description.length > 0, `${p.id} has no description`);
    assert.ok(typeof p.icon === "function" || typeof p.icon === "object", `${p.id} has no icon`);
  }
});

test("every kind of plugin page has a route in the lazy chunk", () => {
  const src = readFileSync(join(SRC, "settings-panels.tsx"), "utf8");
  // One component draws every kind's page; the route comment names each kind it takes.
  for (const kind of PLUGIN_PAGE_KINDS) assert.ok(src.includes(`"${kind}"`), `no route renders plugin:${kind}:<id> pages`);
  assert.deepEqual(pluginPage("plugin:widget:pet"), { kind: "widget", pluginId: "pet" });
  assert.equal(pluginPage("plugin:theme:dark"), null, "a kind there is no plugin of opens nothing");
});

test("page ids resolve: fixed, per plugin, and the links of the pages Plugins replaced", () => {
  assert.equal(resolveSettingsPage("plugins"), "plugins");
  assert.equal(resolveSettingsPage("plugin:tool:hivemind/web"), "plugin:tool:hivemind/web");
  // Links other code, docs and people's habits still use.
  for (const old of ["agents", "views", "tools", "installed"]) assert.equal(resolveSettingsPage(old), "plugins");
  assert.equal(resolveSettingsPage("agent:claude"), "plugin:agent:claude");
  assert.equal(resolveSettingsPage("view:@dip497/board"), "plugin:view:@dip497/board");
  assert.equal(resolveSettingsPage("tool:hivemind/web"), "plugin:tool:hivemind/web");
  assert.equal(resolveSettingsPage("extensions"), null, "an unknown page id resolves to nothing");
  assert.equal(resolveSettingsPage("agent:"), null);
  assert.equal(resolveSettingsPage("plugin:agent:"), null);
  assert.equal(resolveSettingsPage("nope"), null);
});

test("the sidebar is four groups, in this order, each page named for what the person does there", () => {
  const shown = SETTINGS_NAV.map(({ group, pages }) => [group, pages.map((p) => (p.hint ? [p.label, p.hint] : p.label))]);
  assert.deepEqual(shown, [
    ["General", ["Profile", "Appearance", "Notifications", "Shortcuts"]],
    ["Connect", [
      ["People", "Invite people to this workspace"],
      ["Your devices", "Your phone, other computers, a browser tab"],
      ["API access", "Scripts and tools that drive agents"],
    ]],
    ["Plugins", ["Plugins"]],
    ["Advanced", [["Servers", "Relay and discovery; most people never change this"], "About and updates"]],
  ]);
});

test("the ids the pages had before Connect still open them, so links and docs land", () => {
  assert.equal(resolveSettingsPage("share"), "people");
  assert.equal(resolveSettingsPage("network"), "servers");
  assert.equal(resolveSettingsPage("devices"), "your-devices");
  assert.equal(resolveSettingsPage("programs"), "api");
  for (const id of ["people", "your-devices", "api", "servers", "about"]) assert.equal(resolveSettingsPage(id), id);
});

test("the e2e nav contract is stable: these ids are pinned by specs", () => {
  for (const id of ["appearance", "plugins"]) {
    assert.ok(settingsPage(id), `settings page "${id}" is pinned by an e2e spec and must keep its id`);
  }
});
