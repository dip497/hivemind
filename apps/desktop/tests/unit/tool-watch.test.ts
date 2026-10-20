// A tool's code runs in the app's own page, so what it breaks lands on the window. Each failure
// must reach the tiles of the plugin whose code it came from, and no other plugin's, with a
// reason an agent can act on: a blocked frame says only this machine can be framed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { watchTool } from "../../src/renderer/src/tiles/tool-watch";
import { consoleRings } from "../../src/renderer/src/workspace/plugin-instances";

// The page's window and document, as far as the listeners use them.
const g = globalThis as unknown as { window: EventTarget; document: EventTarget };
g.window = new EventTarget();
g.document = new EventTarget();
const fire = (target: EventTarget, type: string, fields: object) => target.dispatchEvent(Object.assign(new Event(type), fields));

function watched() {
  const got: Record<string, string[]> = { prs: [], other: [] };
  const undo = [
    watchTool({ folder: "acme--prs", instance: "tile-prs", element: () => null, fail: (why) => got.prs!.push(why) }),
    watchTool({ folder: "acme--other", instance: "tile-other", element: () => null, fail: (why) => got.other!.push(why) }),
  ];
  return { got, done: () => undo.forEach((u) => u()) };
}

test("an uncaught error from a plugin's code fails that plugin's tiles only, with its message", () => {
  const { got, done } = watched();
  const error = new Error("cannot read x of undefined");
  error.stack = "TypeError: cannot read x of undefined\n    at Tile (hm-plugin://host/sdk.js:1:2)\n    at onClick (hm-plugin://acme--prs/index.js?g=3:10:4)";
  fire(g.window, "error", { message: "Uncaught TypeError", filename: "file:///app/index.js", error });
  // The app's own errors are no plugin's.
  fire(g.window, "error", { message: "boom", filename: "file:///app/index.js", error: new Error("boom") });
  done();
  assert.deepEqual(got, { prs: ["cannot read x of undefined"], other: [] });
});

test("a rejection nothing heard, from a plugin's code, fails its tiles", () => {
  const { got, done } = watched();
  const reason = new Error("fetch failed");
  reason.stack = "Error: fetch failed\n    at load (hm-plugin://acme--other/index.js:4:1)";
  fire(g.window, "unhandledrejection", { reason });
  done();
  assert.deepEqual(got, { prs: [], other: ["a promise rejected: fetch failed"] });
});

test("a frame the page's policy blocks fails the tile and says a tool may frame only this machine", () => {
  const { got, done } = watched();
  fire(g.document, "securitypolicyviolation", { blockedURI: "http://10.0.0.5:8080/", effectiveDirective: "frame-src", sourceFile: "hm-plugin://acme--prs/index.js" });
  done();
  assert.equal(got.prs!.length, 1);
  assert.match(got.prs![0]!, /blocked http:\/\/10\.0\.0\.5:8080\/ \(frame-src\)/);
  assert.match(got.prs![0]!, /127\.0\.0\.1/);
  assert.deepEqual(got.other, []);
});

test("a blocked frame reported on the document, with no source, fails the tile whose frame asked for it", () => {
  const got: string[] = [];
  const box = { contains: () => false, querySelectorAll: () => [{ src: "http://192.0.2.1/" }] } as unknown as Element;
  const undo = watchTool({ folder: "acme--frames", instance: "tile-frames", element: () => box, fail: (why) => got.push(why) });
  const { got: others, done } = watched();
  fire(g.document, "securitypolicyviolation", { blockedURI: "http://192.0.2.1/", effectiveDirective: "frame-src", sourceFile: "" });
  undo(); done();
  assert.equal(got.length, 1);
  assert.deepEqual(others, { prs: [], other: [] });
});

test("a tile no longer watched hears nothing", () => {
  const { got, done } = watched();
  done();
  const error = new Error("late");
  error.stack = "Error: late\n    at x (hm-plugin://acme--prs/index.js:1:1)";
  fire(g.window, "error", { error });
  assert.deepEqual(got, { prs: [], other: [] });
});

test("what a plugin's code writes to the console is kept for its tiles only, with its errors; a tile let go keeps none", () => {
  const got: string[] = [];
  const undo = watchTool({ folder: "acme--prs", instance: "tile-prs", element: () => null, fail: (why) => got.push(why) });
  const other = watchTool({ folder: "acme--other", instance: "tile-other", element: () => null, fail: () => {} });
  // Code that runs from the plugin's module, as the page loads it.
  new Function("console.warn('rate limited', { retry: 3 })\n//# sourceURL=hm-plugin://acme--prs/index.js")();
  console.log("the app's own line");
  const error = new Error("boom");
  error.stack = "Error: boom\n    at x (hm-plugin://acme--prs/index.js:1:1)";
  fire(g.window, "error", { error });
  assert.deepEqual(consoleRings.read("tile-prs").map((l) => [l.level, l.text]), [["warn", 'rate limited {"retry":3}'], ["error", "boom"]]);
  assert.deepEqual(consoleRings.read("tile-other"), []);
  undo(); other();
  assert.deepEqual(consoleRings.read("tile-prs"), []);
});
