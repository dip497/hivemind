// The manifest is the only thing a host reads before it trusts a package, so what it may
// claim — and what it may not — is checked here.
import { describe, expect, it } from "bun:test";
import { validateViewManifest } from "../src/manifest";

describe("provenance the package claims about itself", () => {
  const base = { id: "view", name: "V", version: "1.0.0", entry: "index.html", protocol: 1, permissions: [] };
  it("keeps an author, an https homepage and a licence", () => {
    const r = validateViewManifest({ ...base, author: "Ada", homepage: "https://example.com/v", license: "MIT" });
    expect(r.ok).toBe(true);
    if (r.ok) expect([r.manifest.author, r.manifest.homepage, r.manifest.license]).toEqual(["Ada", "https://example.com/v", "MIT"]);
  });
  it("refuses a homepage that is not https, and a licence that is a sentence", () => {
    for (const bad of [{ homepage: "http://example.com" }, { homepage: "javascript:alert(1)" }, { license: "do what you want" }]) {
      expect(validateViewManifest({ ...base, ...bad }).ok).toBe(false);
    }
  });
});

describe("the screens a view says it works on", () => {
  const base = { id: "view", name: "V", version: "1.0.0", entry: "index.html", protocol: 1, permissions: [] };
  it("keeps `phone` as it says, says nothing of it when the view does not, and refuses anything but true or false", () => {
    const phone = (extra: object) => { const r = validateViewManifest({ ...base, ...extra }); return r.ok ? r.manifest.phone : r.errors; };
    expect(phone({ phone: true })).toBe(true);
    expect(phone({ phone: false })).toBe(false);
    expect(phone({})).toBeUndefined();
    expect(phone({ phone: "yes" })).toEqual(['"phone" must be true or false']);
  });
});

describe("the settings a view declares", () => {
  const base = { id: "view", name: "V", version: "1.0.0", entry: "index.html", protocol: 1, permissions: [] };
  it("keeps each field it can draw, and names each one it cannot instead of dropping it unsaid", () => {
    const ok = validateViewManifest({ ...base, settings: [{ id: "columns", label: "Columns", type: "choice", values: ["todo", "all"] }] });
    expect(ok.ok && ok.manifest.settings).toEqual([{ id: "columns", label: "Columns", type: "choice", values: ["todo", "all"], default: "todo" }]);
    const bad = validateViewManifest({ ...base, settings: [{ id: "max", type: "number", default: "lots" }, { id: "max", type: "boolean" }, { id: "max", type: "boolean" }] });
    expect(bad.ok ? [] : bad.errors).toEqual([
      "settings[0] is not a field: an id, a type (boolean, number, text, choice, color, multi or list), a default that fits it, and a showIf that names a field before it",
      "settings[2] is not a field: an id, a type (boolean, number, text, choice, color, multi or list), a default that fits it, and a showIf that names a field before it",
    ]);
    expect(validateViewManifest({ ...base, settings: {} }).ok).toBe(false);
  });
});

describe("what a view asks of the app around it", () => {
  const base = { id: "view", name: "V", version: "1.0.0", entry: "index.html", protocol: 1, permissions: [] };
  const read = (extra: object) => { const r = validateViewManifest({ ...base, ...extra }); return r.ok ? [r.manifest.layers, r.manifest.layout] : r.errors; };
  it("keeps the app's Layers rail and a personal layout when it asks, and nothing when it does not", () => {
    expect(read({ layers: true, layout: "personal" })).toEqual([true, "personal"]);
    expect(read({})).toEqual([undefined, undefined]);
  });
  it("keeps where it wants the app's toolbar, and refuses a place there is none", () => {
    const where = (toolbar: unknown) => { const r = validateViewManifest({ ...base, toolbar }); return r.ok ? r.manifest.toolbar : r.errors; };
    expect(["top", "bottom", "hidden", "off"].map(where)).toEqual(["top", "bottom", "hidden", "off"]);
    expect(where("left")).toEqual(['"toolbar" must be "top", "bottom", "hidden" or "off"']);
    expect(where(undefined)).toBeUndefined();
  });
  it("keeps the edge it wants the app's widget cards down, and refuses one there is none", () => {
    const edge = (widgets: unknown) => { const r = validateViewManifest({ ...base, widgets }); return r.ok ? r.manifest.widgets : r.errors; };
    expect(["left", "right"].map(edge)).toEqual(["left", "right"]);
    expect(edge("top")).toEqual(['"widgets" must be "left" or "right"']);
    expect(edge(undefined)).toBeUndefined();
  });
  it("keeps whether it fetches its own files, and refuses anything but true or false", () => {
    const files = (v: unknown) => { const r = validateViewManifest({ ...base, files: v }); return r.ok ? r.manifest.files : r.errors; };
    expect([true, false].map(files)).toEqual([true, false]);
    expect(files("yes")).toEqual(['"files" must be true or false']);
    expect(files(undefined)).toBeUndefined();
  });
  it("refuses a rail or a layout it cannot mean", () => {
    expect(read({ layers: "left" })).toEqual(['"layers" must be true or false']);
    expect(read({ layout: "mine" })).toEqual(['"layout" must be "shared" or "personal"']);
  });
});

describe("what a plugin is for", () => {
  const base = { id: "view", name: "V", version: "1.0.0", entry: "index.html", protocol: 1, permissions: [] };
  it("keeps a category from the list, is `other` without one, and refuses one not on it", () => {
    const category = (extra: object) => { const r = validateViewManifest({ ...base, ...extra }); return r.ok ? r.manifest.category : r.errors; };
    expect(category({ category: "git" })).toBe("git");
    expect(category({})).toBe("other");
    expect(category({ category: "games" })).toEqual(['"category" must be one of code, git, agents, productivity, monitoring, team, web, fun, other']);
  });
});

describe("how a view is shown where views are listed", () => {
  const base = { id: "view", name: "V", version: "1.0.0", entry: "index.html", protocol: 1, permissions: [] };
  it("keeps a one-line description and an .svg icon inside the package", () => {
    const r = validateViewManifest({ ...base, description: "Your issues as columns.", icon: "assets/icon.svg" });
    expect(r.ok && [r.manifest.description, r.manifest.icon]).toEqual(["Your issues as columns.", "assets/icon.svg"]);
  });
  it("refuses an icon outside the package or not an .svg, and a description of several lines or over 200 characters", () => {
    const errors = (extra: object) => { const r = validateViewManifest({ ...base, ...extra }); return r.ok ? [] : r.errors; };
    for (const icon of ["/etc/icon.svg", "../icon.svg", "a/../../icon.svg", "icon.png", "C:/icon.svg", ""]) {
      expect(errors({ icon })).toEqual(['"icon" must be a relative path to an .svg file inside the package']);
    }
    for (const description of ["Line one\nline two", "x".repeat(201), "  "]) {
      expect(errors({ description })).toEqual(['"description" must be one line of at most 200 characters']);
    }
    expect(errors({ description: "x".repeat(200) })).toEqual([]);
  });
});
