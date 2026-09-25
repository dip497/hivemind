// The TypeScript vocabulary and the language-neutral spec must say the same thing.
import { expect, test } from "bun:test";
import fs from "node:fs";
import { AGENT_EVENTS, INPUT_KINDS, TURN_OUTCOMES } from "../src/events.js";
import { SESSION_STATES } from "../src/status.js";

const read = (p: string) => fs.readFileSync(new URL(`../../../spec/${p}`, import.meta.url), "utf8");
type Schema = { properties: Record<string, { enum?: string[] }> };
const schema = JSON.parse(read("agent-event.schema.json")) as Schema;
const status = JSON.parse(read("status.schema.json")) as Schema;

test("event names, outcomes and input kinds match the event schema", () => {
  expect([...AGENT_EVENTS]).toEqual(schema.properties.event.enum!);
  expect([...TURN_OUTCOMES]).toEqual(schema.properties.outcome.enum!);
  expect([...INPUT_KINDS]).toEqual(schema.properties.kind.enum!);
});

test("states and waiting kinds match the status schema", () => {
  expect([...SESSION_STATES]).toEqual(status.properties.state.enum!);
  expect([...INPUT_KINDS]).toEqual(status.properties.kind.enum!);
});
