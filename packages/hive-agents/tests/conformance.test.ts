// The status fold against the shared, language-neutral conformance cases.
import { expect, test } from "bun:test";
import fs from "node:fs";
import { INITIAL_STATUS, foldStatus, type StatusInput } from "../src/status.js";

const { cases } = JSON.parse(fs.readFileSync(new URL("../../../conformance/status.json", import.meta.url), "utf8")) as {
  cases: Array<{ name: string; inputs: StatusInput[]; expect: unknown }>;
};

for (const c of cases) test(c.name, () => expect(c.inputs.reduce(foldStatus, INITIAL_STATUS)).toEqual(c.expect as never));
