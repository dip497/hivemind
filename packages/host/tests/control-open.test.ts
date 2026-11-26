// `opener.open` (control-api.ts): an agent opens where it is, in its own tile's frame, whatever tile
// it names; the person names the tile, or none and the window picks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import { controlApi } from "../src/control-api.ts";
import type { ControlWork } from "../src/control/methods.ts";

const person: Connection = { actor: { kind: "person" }, send: () => {}, closed: new AbortController().signal };
const agent: Connection = { actor: { kind: "peer", person: "t7", device: "t7", access: "agents", client: "reviewer", tile: "t7" }, send: () => {}, closed: new AbortController().signal };

test("an agent opens in its own tile; the person in the tile named", async () => {
  const asked: unknown[][] = [];
  const work = { open: async (thing: string, tile: string | undefined) => { asked.push([thing, tile]); return { to: "code", path: thing }; } } as unknown as ControlWork;
  const server = new WorkspaceServer([controlApi({ control: async () => work })], { perform: async (_a, _i, run) => run() });
  await server.answer("opener.open", ["/w/a.ts", "t1"], agent);
  await server.answer("opener.open", ["/w/a.ts", "t1"], person);
  await server.answer("opener.open", ["/w/a.ts"], person);
  assert.deepEqual(asked, [["/w/a.ts", "t7"], ["/w/a.ts", "t1"], ["/w/a.ts", undefined]]);
});
