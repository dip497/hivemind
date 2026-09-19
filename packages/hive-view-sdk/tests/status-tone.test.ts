// A status has one meaning and the host decides its colour. These pin the two halves of that:
// every status maps to a tone, and every tone reaches a view — from a new host or an old one.
import { describe, expect, test } from "bun:test";
import { applyThemeVars, type ViewClient } from "../src/client.js";
import { STATUS_TONES, statusTone, type ViewStatus, type ViewTheme } from "../src/protocol.js";

function paint(theme: ViewTheme): Map<string, string> {
  const props = new Map<string, string>();
  const root = { style: { setProperty: (k: string, v: string) => props.set(k, v) }, dataset: {} } as unknown as HTMLElement;
  const client = { hello: { theme }, on: () => () => {} } as unknown as ViewClient;
  applyThemeVars(client, root);
  return props;
}

const palette = { bg: "#101112", fg3: "#8a8f98", brand: "#e6e7e9", warn: "#e0a040", ok: "#7fae8f", err: "#c0604a" };

describe("status tones", () => {
  test("every status has a tone, and every way of needing you is attention", () => {
    const all: ViewStatus[] = ["unknown", "idle", "working", "blocked", "exited"];
    expect(all.map(statusTone)).toEqual(["idle", "idle", "working", "attention", "exited"]);
  });

  test("a host's own status colours are what a view paints with", () => {
    const props = paint({ colors: palette, status: { working: "#ffffff", attention: "#ff8800" } });
    expect(props.get("--hm-status-working")).toBe("#ffffff");
    expect(props.get("--hm-status-attention")).toBe("#ff8800");
  });

  test("a host that predates tones still gives a view every one, from its palette", () => {
    const props = paint({ colors: palette });
    for (const tone of STATUS_TONES) expect(props.has(`--hm-status-${tone}`)).toBe(true);
    expect(props.get("--hm-status-attention")).toBe(palette.warn);
    expect(props.get("--hm-status-exited")).toBe(palette.fg3);
  });

  test("anything that is not a colour is not set", () => {
    const props = paint({ colors: palette, status: { working: "red; background: url(x)" } });
    expect(props.get("--hm-status-working")).toBe(palette.brand);
  });
});
