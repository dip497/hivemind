// An agent can say which Hivemind it needs. The catalog lists it, so an older app never
// downloads the plugin; the manifest only has to say it well-formed.
import { expect, test } from "bun:test";
import { defFromManifest } from "../src/manifest.ts";

const manifest = (minAppVersion?: unknown) => ({
  manifestVersion: 2, id: "acme", label: "Acme", bin: "acme",
  caps: { promptDelivery: "typed", turnSignal: false, resume: "none", supervise: "human", blockedDetection: false },
  ...(minAppVersion === undefined ? {} : { minAppVersion }),
});

test("minAppVersion is a version or nothing", () => {
  expect(defFromManifest(manifest("2026.9.6")).minAppVersion).toBe("2026.9.6");
  expect(defFromManifest(manifest()).minAppVersion).toBeUndefined();
  expect(() => defFromManifest(manifest("next"))).toThrow(/minAppVersion/);
  expect(() => defFromManifest(manifest(2026.9))).toThrow(/minAppVersion/);
});

test("a manifest written for an older agent host is refused", () => {
  expect(() => defFromManifest({ ...manifest(), manifestVersion: 1 })).toThrow(/manifestVersion must be 2/);
});
