import { expect, test } from "bun:test";
import { fontNameOf, fontStack } from "./font-names.js";

test("a font picked from the computer's list is named by its family, and a list the person typed stays theirs", () => {
  expect(fontNameOf("mono", fontStack("mono", "Iosevka Term"), null)).toEqual({ kind: "computer", family: "Iosevka Term", label: "Iosevka Term" });
  expect(fontNameOf("ui", fontStack("ui", "Noto Sans"), null)).toEqual({ kind: "computer", family: "Noto Sans", label: "Noto Sans" });
  expect(fontNameOf("mono", '"Iosevka Term", monospace', null)).toEqual({ kind: "custom", label: "Iosevka Term" });
  // The list is the slot's: a code font's list in the interface row was typed there.
  expect(fontNameOf("ui", fontStack("mono", "Iosevka Term"), null).kind).toBe("custom");
});

test("a code font the app ships is named, wherever its list came from", () => {
  expect(fontNameOf("mono", fontStack("mono", "Fira Code"), null)).toEqual({ kind: "named", id: "fira-code", label: "Fira Code" });
});
