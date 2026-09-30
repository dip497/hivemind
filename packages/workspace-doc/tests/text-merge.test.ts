// Merging what two people typed in one text (text-merge.ts, design §4.4): edits in different places
// both land; where both touched one place, both insertions are kept, the writer's first; what
// either deleted goes; and, whatever the edits, every character either side inserted is in the
// result and the base's characters that neither deleted keep their order.
import { test, expect } from "bun:test";
import { mergeText } from "../src/text-merge.ts";

test("edits in different places both land; one side unchanged gives the other", () => {
  expect(mergeText("hello world", "hello, world", "hello world!")).toBe("hello, world!");
  expect(mergeText("abc", "abc", "aXbc")).toBe("aXbc");
  expect(mergeText("abc", "abYc", "abc")).toBe("abYc");
  expect(mergeText("abcdef", "adef", "abcdeZf")).toBe("adeZf");
});

test("both typing at one place keep both, the writer's first; a deletion under someone's typing keeps their typing", () => {
  expect(mergeText("ab", "aXb", "aYb")).toBe("aXYb");
  expect(mergeText("", "mine", "theirs")).toBe("minetheirs");
  expect(mergeText("abcdef", "aef", "abcXdef")).toBe("aXef");
});

/** A seeded random number generator. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** `text` with `n` tokens tagged `tag` inserted at random places, never inside another token. */
function typeInto(text: string, tag: string, n: number, rnd: () => number): { text: string; tokens: string[] } {
  const units = text.match(/<[^>]*>|./g) ?? [];
  const tokens: string[] = [];
  for (let i = 0; i < n; i++) {
    const token = `<${tag}${i}>`;
    tokens.push(token);
    units.splice(Math.floor(rnd() * (units.length + 1)), 0, token);
  }
  return { text: units.join(""), tokens };
}

test("whatever the edits, every character either side typed is kept, once, and the rest keeps its order", () => {
  for (let seed = 1; seed <= 500; seed++) {
    const rnd = random(seed);
    const base = Array.from({ length: Math.floor(rnd() * 40) }, () => "abcde"[Math.floor(rnd() * 5)]).join("");
    const mine = typeInto(base, "m", Math.floor(rnd() * 5), rnd);
    const theirs = typeInto(base, "t", Math.floor(rnd() * 5), rnd);
    const merged = mergeText(base, mine.text, theirs.text);
    expect((merged.match(/<[mt]\d+>/g) ?? []).sort(), `seed ${seed}`).toEqual([...mine.tokens, ...theirs.tokens].sort());
    expect(merged.replace(/<[mt]\d+>/g, ""), `seed ${seed}`).toBe(base);
  }
});
