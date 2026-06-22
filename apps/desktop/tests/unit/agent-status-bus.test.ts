// Unit tests for the agent status bus — the dedupe gate is the real logic
// (the poll re-asserts the same status every tick; only transitions must fire).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  publishStatus,
  subscribeStatus,
  clearStatus,
  setWaitStatus,
  setSubagentBusy,
  setNotify,
  setTurnState,
  statusOf,
  noteOutput,
} from "../../src/renderer/src/agent-status-bus.ts";

test("subscribers receive published events", () => {
  const seen: string[] = [];
  const off = subscribeStatus((e) => seen.push(`${e.tileId}:${e.status}`));
  publishStatus({ tileId: "t1", label: "claude", status: "working" });
  publishStatus({ tileId: "t1", label: "claude", status: "idle" });
  off();
  assert.deepEqual(seen, ["t1:working", "t1:idle"]);
});

test("identical status+label is deduped (no repeat events)", () => {
  clearStatus("t2");
  let count = 0;
  const off = subscribeStatus((e) => { if (e.tileId === "t2") count++; });
  publishStatus({ tileId: "t2", label: "codex", status: "working" });
  publishStatus({ tileId: "t2", label: "codex", status: "working" }); // dup
  publishStatus({ tileId: "t2", label: "codex", status: "blocked" }); // change
  off();
  assert.equal(count, 2);
});

test("clearStatus resets the dedupe memory", () => {
  clearStatus("t3");
  let count = 0;
  const off = subscribeStatus((e) => { if (e.tileId === "t3") count++; });
  publishStatus({ tileId: "t3", label: "amp", status: "idle" });
  clearStatus("t3");
  publishStatus({ tileId: "t3", label: "amp", status: "idle" }); // fires again after clear
  off();
  assert.equal(count, 2);
});

test("unsubscribe stops delivery", () => {
  clearStatus("t4");
  let count = 0;
  const off = subscribeStatus((e) => { if (e.tileId === "t4") count++; });
  publishStatus({ tileId: "t4", label: "grok", status: "working" });
  off();
  publishStatus({ tileId: "t4", label: "grok", status: "idle" });
  assert.equal(count, 1);
});

// --- subagent-busy soft lift (background-agent detection) -----------------

test("subagent-busy lifts a scraped 'idle' to 'working'", () => {
  clearStatus("s1");
  publishStatus({ tileId: "s1", label: "claude", status: "idle" });
  assert.equal(statusOf("s1"), "idle");
  setSubagentBusy("s1", true); // a background agent started
  assert.equal(statusOf("s1"), "working");
  setSubagentBusy("s1", false); // it finished
  assert.equal(statusOf("s1"), "idle");
  clearStatus("s1");
});

test("subagent-busy does NOT mask needs-human base states", () => {
  clearStatus("s2");
  setSubagentBusy("s2", true);
  publishStatus({ tileId: "s2", label: "claude", status: "permission" });
  assert.equal(statusOf("s2"), "permission"); // the human prompt still wins
  publishStatus({ tileId: "s2", label: "claude", status: "question" });
  assert.equal(statusOf("s2"), "question");
  clearStatus("s2");
});

test("explicit wait override beats subagent-busy", () => {
  clearStatus("s3");
  publishStatus({ tileId: "s3", label: "claude", status: "idle" });
  setSubagentBusy("s3", true);
  setWaitStatus("s3", "awaiting_approval");
  assert.equal(statusOf("s3"), "awaiting_approval"); // terminal pause wins
  setWaitStatus("s3", null);
  assert.equal(statusOf("s3"), "working"); // back to the subagent lift
  clearStatus("s3");
});

test("subagent-busy lifts even before any scrape arrives", () => {
  clearStatus("s4");
  setSubagentBusy("s4", true);
  assert.equal(statusOf("s4"), "working");
  clearStatus("s4");
});

// --- notify "needs you" soft override (claude Notification hook) -----------

test("notify lifts an idle tile to permission/question", () => {
  clearStatus("n1");
  publishStatus({ tileId: "n1", label: "claude", status: "idle" });
  setNotify("n1", "permission");
  assert.equal(statusOf("n1"), "permission");
  setNotify("n1", null);
  assert.equal(statusOf("n1"), "idle");
  clearStatus("n1");
});

test("notify auto-clears once the scrape moves off idle (work resumed)", () => {
  clearStatus("n2");
  publishStatus({ tileId: "n2", label: "claude", status: "idle" });
  setNotify("n2", "permission");
  assert.equal(statusOf("n2"), "permission");
  publishStatus({ tileId: "n2", label: "claude", status: "working" }); // resumed → clears notify
  assert.equal(statusOf("n2"), "working");
  publishStatus({ tileId: "n2", label: "claude", status: "idle" }); // stays idle, notify gone
  assert.equal(statusOf("n2"), "idle");
  clearStatus("n2");
});

test("notify yields to an explicit wait override", () => {
  clearStatus("n3");
  publishStatus({ tileId: "n3", label: "claude", status: "idle" });
  setNotify("n3", "permission");
  setWaitStatus("n3", "plan_review");
  assert.equal(statusOf("n3"), "plan_review"); // terminal pause wins
  setWaitStatus("n3", null);
  assert.equal(statusOf("n3"), "permission");
  clearStatus("n3");
});

test("notify does not override a scraped non-idle base", () => {
  clearStatus("n4");
  publishStatus({ tileId: "n4", label: "claude", status: "working" });
  setNotify("n4", "permission"); // notify only lifts idle, not a working base
  assert.equal(statusOf("n4"), "working");
  clearStatus("n4");
});

// --- liveTurn: claude's hook-driven working/idle (the scrape refactor) --------

test("liveTurn idle overrides a stale scraped 'working' (restart bug)", () => {
  clearStatus("lt1");
  // Seed idle on mount; scrape then reads the stale replayed buffer as working.
  setTurnState("lt1", "idle");
  publishStatus({ tileId: "lt1", label: "claude", status: "working" });
  assert.equal(statusOf("lt1"), "idle"); // hook wins → not the stale scrape
  setTurnState("lt1", "working"); // a real turn started
  assert.equal(statusOf("lt1"), "working");
  setTurnState("lt1", "idle"); // turn ended (Stop)
  assert.equal(statusOf("lt1"), "idle");
  clearStatus("lt1");
});

test("needs-you (scrape permission) wins over liveTurn working", () => {
  clearStatus("lt2");
  setTurnState("lt2", "working");
  publishStatus({ tileId: "lt2", label: "claude", status: "permission" });
  assert.equal(statusOf("lt2"), "permission"); // mid-turn human prompt wins
  clearStatus("lt2");
});

test("exited wins over liveTurn", () => {
  clearStatus("lt3");
  setTurnState("lt3", "working");
  publishStatus({ tileId: "lt3", label: "claude", status: "exited" });
  assert.equal(statusOf("lt3"), "exited"); // process gone, not 'working'
  clearStatus("lt3");
});

test("subagent-busy lifts a liveTurn-idle tile to working (bg agent after turn)", () => {
  clearStatus("lt4");
  setTurnState("lt4", "idle"); // main turn ended
  setSubagentBusy("lt4", true); // but a background agent is still running
  assert.equal(statusOf("lt4"), "working");
  setSubagentBusy("lt4", false);
  assert.equal(statusOf("lt4"), "idle");
  clearStatus("lt4");
});

test("liveTurn is claude-only: non-claude tiles fall through to the scrape", () => {
  clearStatus("lt5");
  publishStatus({ tileId: "lt5", label: "codex", status: "working" });
  assert.equal(statusOf("lt5"), "working"); // no liveTurn set → scrape base
  clearStatus("lt5");
});

test("a live hook 'working' turn is NOT overridden by a scraped idle (silent thinking)", () => {
  clearStatus("lt6");
  setTurnState("lt6", "working"); // turn started (UserPromptSubmit)
  assert.equal(statusOf("lt6"), "working");
  // The scrape can misread a SILENT "max effort" thinking screen (frozen timer,
  // no output) as idle — but the hook knows the turn is live, so working stands.
  // Letting the scrape's idle win here was the "genuinely-working shows idle" bug.
  publishStatus({ tileId: "lt6", label: "claude", status: "idle" });
  assert.equal(statusOf("lt6"), "working");
  setTurnState("lt6", "idle"); // a REAL end fires Stop → idle
  assert.equal(statusOf("lt6"), "idle");
  clearStatus("lt6");
});

test("a stale liveTurn 'working' is NOT cleared by a scraped working (real turn)", () => {
  clearStatus("lt7");
  setTurnState("lt7", "working");
  publishStatus({ tileId: "lt7", label: "claude", status: "working" });
  assert.equal(statusOf("lt7"), "working"); // both agree → working
  clearStatus("lt7");
});

test("subagent-busy + a live turn both keep working; only Stop returns idle", () => {
  clearStatus("lt8");
  setTurnState("lt8", "working");
  setSubagentBusy("lt8", true); // background Task agent running
  publishStatus({ tileId: "lt8", label: "claude", status: "idle" }); // scrape misread
  assert.equal(statusOf("lt8"), "working");
  setSubagentBusy("lt8", false);
  assert.equal(statusOf("lt8"), "working"); // turn still live (no Stop) → working
  setTurnState("lt8", "idle"); // Stop fired → idle
  assert.equal(statusOf("lt8"), "idle");
  clearStatus("lt8");
});

test("setSubagentBusy fires a transition event only on a real edge", () => {
  clearStatus("s5"); // drop emitted so the new subscriber gets no replay
  let count = 0;
  const off = subscribeStatus((e) => { if (e.tileId === "s5") count++; });
  publishStatus({ tileId: "s5", label: "claude", status: "idle" }); // fires: idle
  setSubagentBusy("s5", true);  // idle → working : fires
  setSubagentBusy("s5", true);  // no-op (already busy) : no fire
  setSubagentBusy("s5", false); // working → idle : fires
  off();
  assert.equal(count, 3);
  clearStatus("s5");
});

test("a hook-driven 'working' turn is AUTHORITATIVE — never staleness-decayed (silent thinking)", () => {
  // liveTurn "working" = the turn is genuinely live (UserPromptSubmit, no Stop).
  // Even output-silent for >WORKING_STALE_MS (extended "max effort" thinking with
  // a frozen timer) it must STILL read working — the staleness gate must not touch it.
  setTurnState("st1", "working");
  noteOutput("st1", Date.now() - 60000); // 60s of output silence
  assert.equal(statusOf("st1"), "working");
  setTurnState("st1", "idle"); // Stop fired → idle
  assert.equal(statusOf("st1"), "idle");
  clearStatus("st1");
});

test("staleness gate: a stale scraped 'working' (frozen/replayed buffer) reads idle", () => {
  publishStatus({ tileId: "st2", label: "claude", status: "working" });
  noteOutput("st2", Date.now() - 16000); // output stopped 16s ago
  assert.equal(statusOf("st2"), "idle");
  clearStatus("st2");
});

test("staleness gate does NOT touch a quiet background subagent (event-driven)", () => {
  publishStatus({ tileId: "st3", label: "claude", status: "idle" });
  setSubagentBusy("st3", true);
  noteOutput("st3", Date.now() - 16000); // a background subagent is legitimately quiet
  assert.equal(statusOf("st3"), "working"); // subagent-busy is exempt from staleness
  setSubagentBusy("st3", false);
  clearStatus("st3");
});

test("staleness gate is inert until the tile has produced output at least once", () => {
  // No noteOutput ever → lastOutputAt undefined → not gated (hook/scrape govern).
  setTurnState("st4", "working");
  assert.equal(statusOf("st4"), "working");
  clearStatus("st4");
});
