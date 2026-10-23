// A view's own colours: declared with a default in each mode that follows the theme, set by the
// person like any other setting, and painted on the view's document as `--hm-token-<id>`.
import { describe, expect, test } from "bun:test";
import { applyThemeVars, type ViewClient } from "../src/client.js";
import { validateViewManifest, viewSettingFields } from "../src/manifest.js";
import type { ViewTheme } from "../src/protocol.js";
import { checkTokenDecls, resolveTokens } from "../src/tokens.js";

const base = { id: "isles", name: "Isles", version: "1.0.0", entry: "index.html", protocol: 1, permissions: [] };
const sea = { id: "sea", label: "Sea", dark: "#123a5a", light: "=info" };
const sail = { id: "sail", label: "Sail", dark: "=accent", light: "=accent" };

describe("a view's tokens", () => {
  test("each follows the theme by default, and what the person set wins", () => {
    const { tokens } = checkTokenDecls([sea, sail]);
    const dark = { accent: "#f5a524", info: "#4284c5" }, light = { accent: "#2460b7", info: "#3070b0" };
    expect(resolveTokens(tokens, "dark", dark, {})).toEqual({ sea: "#123a5a", sail: "#f5a524" });
    expect(resolveTokens(tokens, "light", light, {})).toEqual({ sea: "#3070b0", sail: "#2460b7" });
    expect(resolveTokens(tokens, "light", light, { "token-sea": "#00ff88", "token-sail": "" })).toEqual({ sea: "#00ff88", sail: "#2460b7" });
  });

  test("they are its settings: a colour each, under Colours, with the theme's own until set; a declared setting may not take a token's id", () => {
    const ok = validateViewManifest({ ...base, settings: [{ id: "fog", type: "boolean" }], tokens: [sea] });
    expect(ok.ok && viewSettingFields(ok.manifest)).toEqual([
      { id: "fog", label: "fog", type: "boolean", default: false },
      { id: "token-sea", label: "Sea", section: "Colours", type: "color", default: "" },
    ]);
    const clash = validateViewManifest({ ...base, settings: [{ id: "token-sea", type: "color" }] });
    expect(clash.ok ? [] : clash.errors).toEqual(['settings id "token-sea": ids starting "token-" are the colours of its tokens']);
  });

  test("a token with a bad id, a repeated one, or a default that is not a colour or an app colour is named, the rest kept", () => {
    const r = validateViewManifest({ ...base, tokens: [sea, { ...sea }, { id: "Sky", dark: "#000000", light: "#ffffff" }, { id: "mist", dark: "=fog", light: "#ffffff" }, sail] });
    expect(r.ok ? [] : r.errors).toEqual([1, 2, 3].map((i) => `tokens[${i}] is not a token: an id of lowercase letters, digits and dashes, and a dark and a light colour, each #rrggbb or =<app colour>`));
  });

  test("the theme paints each on the view's document, and one it no longer sends is taken off", () => {
    const props = new Map<string, string>();
    let next: ((t: ViewTheme) => void) | undefined;
    const root = { style: { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: (k: string) => props.delete(k) }, dataset: {} } as unknown as HTMLElement;
    const client = { hello: { theme: { colors: {}, tokens: { sea: "#123a5a", sail: "#f5a524", "Bad Id": "#000000" } } }, on: (_: string, cb: (t: ViewTheme) => void) => { next = cb; return () => {}; } } as unknown as ViewClient;
    applyThemeVars(client, root);
    expect([props.get("--hm-token-sea"), props.get("--hm-token-sail"), [...props.keys()].some((k) => k.includes("Bad"))]).toEqual(["#123a5a", "#f5a524", false]);
    next!({ colors: {}, tokens: { sea: "#00ff88" } });
    expect([props.get("--hm-token-sea"), props.has("--hm-token-sail")]).toEqual(["#00ff88", false]);
  });
});
