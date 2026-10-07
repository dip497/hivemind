// What a plugin can be set to: the fields its manifest declares, each checked on its own, and a
// stored value read through its field, so a value an older version stored never reaches the view
// in a shape the view does not expect.
import { describe, expect, test } from "bun:test";
import { parseSettingFields, parseSettingValue, resolveSettings } from "../src/settings.js";

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
