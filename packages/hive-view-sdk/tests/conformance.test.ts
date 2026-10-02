// The view protocol's commands, held to conformance/view-commands.json, which the phone's core reads
// too (crates/hive-phone/tests/viewing.rs): the permission each needs, from which the phone tells
// what starts or closes something on the board and asks its lock first.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { COMMAND_PERMISSION } from "../src/protocol.js";

const cases = JSON.parse(readFileSync(new URL("../../../conformance/view-commands.json", import.meta.url), "utf8")) as {
  commands: Record<string, string | null>;
};

test("each command needs the permission conformance/view-commands.json says, and it has every command", () => {
  expect(COMMAND_PERMISSION).toEqual(cases.commands);
});
