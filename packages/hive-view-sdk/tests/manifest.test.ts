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
