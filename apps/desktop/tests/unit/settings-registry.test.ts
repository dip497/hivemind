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

const { SETTINGS_PAGES, SETTINGS_PAGE_IDS, PLUGIN_PAGE_KINDS, pluginPage, resolveSettingsPage, settingsPage } = await import("../../src/renderer/src/settings-registry.ts");

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
  for (const kind of PLUGIN_PAGE_KINDS) {
    assert.ok(src.includes(`pp?.kind === "${kind}"`), `no route renders ${kind}:<id> pages`);
  }
});

test("page ids resolve: fixed, per plugin, and old links", () => {
  assert.equal(resolveSettingsPage("agents"), "agents");
  assert.deepEqual(pluginPage("agent:claude"), { kind: "agent", pluginId: "claude" });
  assert.deepEqual(pluginPage("tool:hivemind/web"), { kind: "tool", pluginId: "hivemind/web" });
  assert.equal(resolveSettingsPage("extensions"), "installed", "the old Extensions page lands on Installed");
  assert.equal(resolveSettingsPage("agent:"), null);
  assert.equal(resolveSettingsPage("nope"), null);
});

test("the e2e nav contract is stable: these ids are pinned by specs", () => {
  for (const id of ["appearance", "agents", "views", "tools", "installed"]) {
    assert.ok(settingsPage(id), `settings page "${id}" is pinned by an e2e spec and must keep its id`);
  }
});
