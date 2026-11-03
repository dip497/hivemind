// The code feature (protocol 1.19): a view with `workspace:code` finds a frame's files and lines
// and opens one in its editor; the client refuses a view without it before anything is sent, and
// the host refuses one that sends it anyway, a frame that is not there, and a path outside the
// frame's folder.
import { expect, test } from "bun:test";
import { fakeHost } from "../src/testing.js";
import type { CodeCall } from "../src/protocol.js";

const frame = { id: "f1", title: "web", color: "#336699" };

test("a view with the permission finds files and lines in a frame, pages, and opens one at its line", async () => {
  const calls: CodeCall[] = [];
  const host = fakeHost({
    features: ["code"], capabilities: ["workspace:code"],
    answers: {
      code: (c) => {
        calls.push(c);
        if (c.call === "findFiles") return { files: [{ path: "src/cart.ts" }], engine: "fff" };
        if (c.call === "grep") return { lines: [], next: c.cursor ? null : 1, files: 3, engine: "fff" };
        if (c.call === "open") return { tileId: "ed1" };
        return null;
      },
    },
  });
  const hm = await host.connect();
  host.send({ type: "structure", frames: [frame], tiles: [] });
  await host.settle();
  expect(await hm.code.findFiles("f1", "chkcart", { limit: 20 })).toEqual({ files: [{ path: "src/cart.ts" }], engine: "fff" });
  const first = await hm.code.grep("f1", "TAX_RATE", { mode: "regex", caseSensitive: true });
  expect((await hm.code.grep("f1", "TAX_RATE", { cursor: first.next! })).next).toBe(null);
  await hm.code.picked("f1", "chkcart", "src/cart.ts");
  // null: the workspace's own folder, for a workspace with no frames.
  await hm.code.findFiles(null, "readme");
  expect(await hm.code.open("f1", "src/cart.ts", { line: 12, col: 4 })).toEqual({ tileId: "ed1" });
  expect(calls).toEqual([
    { call: "findFiles", frameId: "f1", query: "chkcart", limit: 20 },
    { call: "grep", frameId: "f1", query: "TAX_RATE", mode: "regex", caseSensitive: true },
    { call: "grep", frameId: "f1", query: "TAX_RATE", cursor: 1 },
    { call: "picked", frameId: "f1", query: "chkcart", file: "src/cart.ts" },
    { call: "findFiles", frameId: null, query: "readme" },
    { call: "open", frameId: "f1", file: "src/cart.ts", line: 12, col: 4 },
  ]);
  expect(host.refused).toEqual([]);
});

test("without the permission the client throws and the host refuses; a missing frame and a path outside it are refused", async () => {
  const bare = fakeHost({ features: ["code"], answers: { code: () => null } });
  const hm = await bare.connect();
  expect(() => hm.code.grep("f1", "x")).toThrow('needs permission "workspace:code"');
  expect(() => hm.code.open("f1", "a.ts")).toThrow('needs permission "workspace:code"');
  const port = hm as unknown as { send(m: unknown): void };
  bare.send({ type: "structure", frames: [frame], tiles: [] });
  port.send({ type: "request", requestId: 90, name: "code", args: [{ call: "grep", frameId: "f1", query: "x" }] });
  await bare.settle();
  expect(bare.refused).toEqual(['code grep needs permission "workspace:code"']);

  const host = fakeHost({ features: ["code"], capabilities: ["workspace:code"], answers: { code: () => null } });
  const hm2 = await host.connect();
  host.send({ type: "structure", frames: [frame], tiles: [] });
  await host.settle();
  const raw = hm2 as unknown as { send(m: unknown): void };
  raw.send({ type: "request", requestId: 91, name: "code", args: [{ call: "grep", frameId: "nope", query: "x" }] });
  raw.send({ type: "request", requestId: 92, name: "code", args: [{ call: "open", frameId: "f1", file: "../../etc/passwd" }] });
  raw.send({ type: "request", requestId: 93, name: "code", args: [{ call: "open", frameId: "f1", file: "/etc/passwd" }] });
  raw.send({ type: "request", requestId: 94, name: "code", args: [{ call: "grep", frameId: "f1", query: "" }] });
  raw.send({ type: "request", requestId: 95, name: "code", args: [{ call: "grep", frameId: "f1", query: "x", mode: "glob" }] });
  raw.send({ type: "request", requestId: 96, name: "code", args: [{ call: "findFiles", frameId: "f1", query: "x", limit: 5000 }] });
  await host.settle();
  expect(host.refused).toEqual([
    "code: unknown frame nope",
    "request: file must be a path inside the frame's folder",
    "request: file must be a path inside the frame's folder",
    "request: query must be 1 to 1000 characters",
    "request: mode must be one of plain, regex, fuzzy",
    "request: limit must be a whole number from 1 to 500",
  ]);
});

test("a host without the feature: the view is told it cannot, and nothing is sent", async () => {
  const host = fakeHost({ features: [], capabilities: ["workspace:code"] });
  const hm = await host.connect();
  expect(hm.supports("code")).toBe(false);
  await expect(hm.code.findFiles("f1", "x")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  await host.settle();
  expect(host.received.filter((m) => m.type === "request")).toEqual([]);
});
