// How a host looks to its guests (appearance.ts): `appearance.get` answers the host's theme with
// nothing of its disk or its fonts, and every client is told when what a guest sees changes, and
// only then.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Intents, type Actor } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import type { EventMessage } from "@hivemind/workspace-api/protocol";
import { DEFAULT_APPEARANCE, DEFAULT_SETTINGS, lookForGuests, type Appearance, type SharedAppearance } from "@hivemind/core/settings-schema";
import { appearance } from "../src/appearance.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-appearance-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function host(start: SharedAppearance) {
  let current = start;
  let changed: (a: SharedAppearance) => void = () => {};
  const server: WorkspaceServer = new WorkspaceServer(
    [appearance({ current: () => current, onChange: (l) => { changed = l; }, server: () => server })],
    new Intents(new AuditLog({ file: path.join(tmp, "audit.jsonl") })),
  );
  const told: EventMessage[] = [];
  const guest: Connection = { actor: { kind: "peer", person: "b".repeat(64), device: "d".repeat(64), access: "view" } as Actor, send: (m) => told.push(m), closed: new AbortController().signal };
  server.connect(guest);
  const set = (a: SharedAppearance) => { current = a; changed(a); };
  return { server, guest, told, set };
}

// What is left out is sharedAppearance's (hive-core); here, that the answer is that form.
test("a guest is given the host's theme in the form shared with guests", async () => {
  const h = host({ ...DEFAULT_APPEARANCE, preset: "nord", accent: "ice", uiFont: "Host Sans", wallpaper: { kind: "image", imageSrc: "hm-media://v/%2Fhome%2Fhost%2Fme.png", brightness: 0.8 } });
  const answer = await h.server.answer("appearance.get", [], h.guest);
  assert.ok("result" in answer);
  const got = answer.result as Appearance;
  assert.equal(got.preset, "nord");
  assert.equal(got.accent, "ice");
  assert.equal(got.uiFont, DEFAULT_APPEARANCE.uiFont);
});

test("guests are told when the host's look changes, and not when only what they never see does", () => {
  const h = host(DEFAULT_APPEARANCE);
  h.set({ ...DEFAULT_APPEARANCE, uiFont: "Host Sans" });
  h.set({ ...DEFAULT_APPEARANCE, wallpaper: { kind: "video", videoSrc: "hm-media://v/x.mp4", brightness: DEFAULT_APPEARANCE.wallpaper.brightness } });
  assert.equal(h.told.length, 0);
  h.set({ ...DEFAULT_APPEARANCE, accent: "rose", mode: "light" });
  assert.equal(h.told.length, 1);
  assert.equal(h.told[0]!.event, "appearance.changed");
  assert.deepEqual([(h.told[0]!.params[0] as Appearance).accent, (h.told[0]!.params[0] as Appearance).mode], ["rose", "light"]);
});

test("a colour of the host's own for the accent reaches guests, and changing it is news", async () => {
  const wood = { brand: "#b07a4f", accent: "#c99a72" };
  const h = host(lookForGuests(DEFAULT_SETTINGS));
  h.set(lookForGuests({ appearance: DEFAULT_APPEARANCE, appearanceExtra: { accent: wood } }));
  assert.equal(h.told.length, 1);
  assert.deepEqual((h.told[0]!.params[0] as SharedAppearance).accentCustom, wood);
  const answer = await h.server.answer("appearance.get", [], h.guest);
  assert.ok("result" in answer);
  assert.deepEqual((answer.result as SharedAppearance).accentCustom, wood);
});
