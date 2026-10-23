// What a plugin can be set to: the fields its manifest declares, each checked on its own, and a
// stored value read through its field, so a value an older version stored never reaches the view
// in a shape the view does not expect.
import { describe, expect, test } from "bun:test";
import { checkSettingFields, isFieldShown, parseSettingFields, parseSettingValue, resolveSettings } from "../src/settings.js";

describe("what a plugin declares it can be set to", () => {
  test("each field is checked on its own: a malformed one is left out, the rest kept", () => {
    const fields = parseSettingFields([
      { id: "model", type: "choice", values: ["opus", "sonnet"], default: "sonnet", label: "Model" },
      { id: "fps", type: "number", min: 1, max: 60, default: 600 },
      { id: "greeting", type: "text", default: "hi", maxLength: 4 },
      { id: "loud", type: "boolean" },
      { id: "model", type: "boolean" },             // a second field with the same id
      { id: "a.b", type: "boolean" },               // a dot would split a settings path
      { id: "x", type: "choice", values: [] },      // nothing to choose
      { id: "y", type: "number", min: 5, max: 1 },  // no number fits
      { id: "z", type: "colour" },
    ]);
    expect(fields.map((f) => f.id)).toEqual(["model", "fps", "greeting", "loud"]);
    expect(fields[1]).toMatchObject({ default: 60 });     // the default is clamped into its range
    expect(fields[3]).toMatchObject({ label: "loud", default: false });
  });

  test("a stored value that no longer fits its field reads as the default", () => {
    const fields = parseSettingFields([
      { id: "model", type: "choice", values: ["opus", "sonnet"], default: "sonnet" },
      { id: "fps", type: "number", min: 1, max: 60, default: 30 },
      { id: "loud", type: "boolean", default: true },
    ]);
    // "haiku" was a choice in an older version; 600 is past the max; "yes" is not a boolean.
    expect(resolveSettings(fields, { model: "haiku", fps: 600, loud: "yes", gone: 1 })).toEqual({ model: "sonnet", fps: 60, loud: true });
    expect(resolveSettings(fields, undefined)).toEqual({ model: "sonnet", fps: 30, loud: true });
  });

  test("a value typed at a command line is taken as its field's type, or refused with what fits", () => {
    const [model, fps, loud] = parseSettingFields([
      { id: "model", type: "choice", values: ["opus", "sonnet"] },
      { id: "fps", type: "number", min: 1, max: 60 },
      { id: "loud", type: "boolean" },
    ]);
    expect(parseSettingValue(fps!, "25")).toBe(25);
    expect(parseSettingValue(loud!, "false")).toBe(false);
    expect(() => parseSettingValue(model!, "haiku")).toThrow("model is one of: opus, sonnet");
    expect(() => parseSettingValue(loud!, "yes")).toThrow("loud is true or false");
    expect(() => parseSettingValue(fps!, "fast")).toThrow("fps is a number");
  });
});

describe("settings v2: colours, several choices, lists, sliders, sections and conditions", () => {
  test("a colour is kept as #rrggbb, or empty for the theme's own; anything else reads as the default", () => {
    const [tint] = parseSettingFields([{ id: "tint", type: "color", default: "#ABC" }]);
    expect(tint).toMatchObject({ type: "color", default: "#aabbcc" });
    expect(resolveSettings([tint!], { tint: "#1D4ED8" })).toEqual({ tint: "#1d4ed8" });
    expect(resolveSettings([tint!], { tint: "" })).toEqual({ tint: "" });
    expect(resolveSettings([tint!], { tint: "red" })).toEqual({ tint: "#aabbcc" });
    expect(parseSettingValue(tint!, "theme")).toBe("");
    expect(() => parseSettingValue(tint!, "blue")).toThrow("tint is a colour like #1d4ed8, or theme for the theme's own");
  });

  test("several choices keep the field's order; one an older version had is dropped, one typed that is not a choice is refused", () => {
    const [days] = parseSettingFields([{ id: "days", type: "multi", values: ["mon", "tue", "wed"], default: ["wed", "mon", "sun"] }]);
    expect(days).toMatchObject({ default: ["mon", "wed"] });
    expect(resolveSettings([days!], { days: ["wed", "fri", "tue"] })).toEqual({ days: ["tue", "wed"] });
    expect(resolveSettings([days!], { days: "mon" })).toEqual({ days: ["mon", "wed"] });
    expect(parseSettingValue(days!, "tue, mon")).toEqual(["mon", "tue"]);
    expect(parseSettingValue(days!, "")).toEqual([]);
    expect(() => parseSettingValue(days!, "mon,sun")).toThrow("days is any of: mon, tue, wed, separated by commas");
  });

  test("a list holds one-line texts, blanks dropped, as many and as long as it allows", () => {
    const [names] = parseSettingFields([{ id: "names", type: "list", maxItems: 2, maxLength: 5 }]);
    expect(names).toMatchObject({ default: [], maxItems: 2, maxLength: 5 });
    expect(resolveSettings([names!], { names: ["ab\ncd", " ", "a", "b"] })).toEqual({ names: ["ab cd", "a"] });
    expect(resolveSettings([names!], { names: ["refunds"] })).toEqual({ names: ["refun"] });
    expect(parseSettingValue(names!, '["a, b", "c"]')).toEqual(["a, b", "c"]);
    expect(parseSettingValue(names!, "x,y")).toEqual(["x", "y"]);
  });

  test("a slider needs both ends, and a step moves by more than nothing", () => {
    const fields = parseSettingFields([
      { id: "zoom", type: "number", min: 1, max: 4, step: 0.5, slider: true, default: 2 },
      { id: "open", type: "number", min: 1, slider: true },
      { id: "still", type: "number", step: 0 },
    ]);
    expect(fields.map((f) => f.id)).toEqual(["zoom"]);
    expect(fields[0]).toMatchObject({ slider: true, step: 0.5 });
  });

  test("a field shows only while the one it names, before it, has the value; a condition that can never hold is refused", () => {
    const { fields, refused } = checkSettingFields([
      { id: "sky", type: "choice", values: ["clock", "custom"], section: "Sky" },
      { id: "hour", type: "number", min: 0, max: 24, showIf: { field: "sky", equals: "custom" }, section: "Sky" },
      { id: "stars", type: "boolean", showIf: { field: "hour", equals: 22 } },
      { id: "late", type: "boolean", showIf: { field: "later", equals: true } },   // no such field before it
      { id: "never", type: "boolean", showIf: { field: "sky", equals: "noon" } },  // sky is never noon
      { id: "later", type: "boolean" },
    ]);
    expect([fields.map((f) => f.id), refused]).toEqual([["sky", "hour", "stars", "later"], [3, 4]]);
    expect(fields[1]).toMatchObject({ section: "Sky" });
    const shown = (values: Record<string, unknown>) => fields.filter((f) => isFieldShown(f, fields, values)).map((f) => f.id);
    expect(shown({})).toEqual(["sky", "later"]);
    expect(shown({ sky: "custom", hour: 12 })).toEqual(["sky", "hour", "later"]);
    // A field shows only while the one it depends on shows too.
    expect(shown({ sky: "custom", hour: 22 })).toEqual(["sky", "hour", "stars", "later"]);
    expect(shown({ sky: "clock", hour: 22 })).toEqual(["sky", "later"]);
  });
});
