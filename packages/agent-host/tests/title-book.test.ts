// A title read before the agent's manifest was there is not lost: it is shown as soon as the
// manifest arrives, without the agent having to set it again.
import { expect, test } from "bun:test";
import { titleBook } from "../src/title-book.js";
import { defFromManifest } from "@hivemind/agents";

const def = defFromManifest({
  manifestVersion: 2, id: "acme", label: "Acme", bin: "acme",
  caps: { promptDelivery: "typed", turnSignal: false, resume: "none", supervise: "human", blockedDetection: false },
  spawn: { titles: ["Acme Coder"] },
});

test("a title read with no manifest is kept, and shows once the manifest is there", () => {
  let known: typeof def | undefined;
  const book = titleBook(() => known);
  expect(book.set("t1", "✳ Fix the flaky test")).toEqual({ changed: false, title: "" });
  expect(book.current()).toEqual([]);
  known = def;
  expect(book.recompute()).toEqual([{ id: "t1", title: "Fix the flaky test" }]);
  expect(book.current()).toEqual([{ id: "t1", title: "Fix the flaky test" }]);
  // Nothing changed the second time.
  expect(book.recompute()).toEqual([]);
});

test("the manifest decides which titles are a task; the rest say nothing", () => {
  const book = titleBook(() => def);
  expect(book.set("t1", "✳ Acme Coder").title).toBe("");
  expect(book.set("t1", "⠹ Write the docs")).toEqual({ changed: true, title: "Write the docs" });
  expect(book.set("t1", "⠿ Write the docs").changed).toBe(false); // a spinner frame is not a change
  expect(book.set("t1", "")).toEqual({ changed: true, title: "" });
  expect(book.current()).toEqual([]);
});

test("a session that goes away is forgotten", () => {
  const book = titleBook(() => def);
  book.set("t1", "✳ Ship it");
  book.forget("t1");
  expect(book.current()).toEqual([]);
  expect(book.recompute()).toEqual([]);
});
