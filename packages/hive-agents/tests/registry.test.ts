import { afterEach, describe, expect, test } from "bun:test";
import {
  getCatalog, setCatalog, subscribeCatalog,
  agentById, agentForCmd, identifyProvider, defaultAgent, preferredAgent, spawnableAgents, workerAgents,
} from "../src/catalog.js";
import { providers } from "../src/node.js";
import type { AgentProviderDef } from "../src/types.js";
import { authoredDefs } from "./authored.js";

// Nothing is compiled in: the tests seed the live catalog the way a machine that
// has installed the published agents would.
const CATALOG = authoredDefs();
const byId = (id: string): AgentProviderDef => {
  const d = CATALOG.find((x) => x.id === id);
  if (!d) throw new Error(`no published fixture "${id}"`);
  return d;
};

const acme: AgentProviderDef = {
  id: "acme", label: "Acme", bin: "acme", aliases: ["acme-cli"], enabled: true,
  caps: {
    promptDelivery: "typed", turnSignal: false, resume: "none", supervise: "human",
    blockedDetection: false,
  },
  icon: { viewBox: "0 0 1 1", body: "" },
  detect: () => "idle",
};

// Global state: every test restores the empty catalog.
afterEach(() => setCatalog([]));

describe("live catalog", () => {
  test("the catalog starts empty — nothing agent-specific is compiled in", () => {
    expect(getCatalog()).toEqual([]);
    expect(defaultAgent()).toBeUndefined();
    expect(spawnableAgents()).toEqual([]);
  });

  test("setCatalog re-resolves every lookup", () => {
    expect(agentById("acme")).toBeUndefined();
    setCatalog([...CATALOG, acme]);
    expect(agentById("acme")?.label).toBe("Acme");
    expect(agentForCmd("/usr/bin/acme --x")?.id).toBe("acme");
    expect(identifyProvider("acme-cli")?.id).toBe("acme");
    expect(spawnableAgents().map((d) => d.id)).toContain("acme");
    setCatalog([]);
    expect(agentById("acme")).toBeUndefined();
    expect(agentForCmd("acme")).toBeUndefined();
    expect(identifyProvider("acme-cli")).toBeUndefined();
  });

  test("removing a provider removes its alias and binary too", () => {
    setCatalog(CATALOG);
    expect(identifyProvider("claude-code")?.id).toBe("claude");
    setCatalog(CATALOG.filter((d) => d.id !== "claude"));
    expect(agentById("claude")).toBeUndefined();
    expect(agentForCmd("claude")).toBeUndefined();
    expect(identifyProvider("claude-code")).toBeUndefined();
  });

  test("subscribers are notified so React can re-render", () => {
    let fired = 0;
    const off = subscribeCatalog(() => { fired++; });
    setCatalog([...CATALOG, acme]);
    setCatalog([]);
    expect(fired).toBe(2);
    off();
    setCatalog([...CATALOG, acme]);
    expect(fired).toBe(2); // unsubscribed
  });

  test("the daemon's provider list follows the live catalog", () => {
    setCatalog(CATALOG);
    expect(providers().map((p) => p.id)).toContain("claude");
    setCatalog(CATALOG.filter((d) => d.id !== "claude"));
    expect(providers().map((p) => p.id)).not.toContain("claude");
  });
});

describe("defaultAgent never throws", () => {
  test("falls back to the first entry when nothing is enabled", () => {
    setCatalog(CATALOG.map((d) => ({ ...d, enabled: false })));
    expect(spawnableAgents()).toEqual([]);
    expect(workerAgents()).toEqual([]);
    expect(() => defaultAgent()).not.toThrow();
    expect(defaultAgent()?.enabled).toBe(false);
  });

  test("is undefined when the catalog is empty", () => {
    setCatalog([]);
    expect(getCatalog()).toEqual([]);
    expect(defaultAgent()).toBeUndefined();
    expect(preferredAgent(undefined, () => true)).toBeUndefined();
  });

  test("prefers an enabled provider over the first entry", () => {
    setCatalog([{ ...acme, enabled: false }, { ...acme, id: "beta", bin: "beta", enabled: true }]);
    expect(defaultAgent()?.id).toBe("beta");
  });
});

describe("preferredAgent", () => {
  const has = (...ids: string[]) => (d: { id: string }) => ids.includes(d.id);
  test("the user's choice wins when it can run here", () => {
    setCatalog([byId("claude"), byId("codex")]);
    expect(preferredAgent("codex", has("claude", "codex"))?.id).toBe("codex");
  });
  test("an uninstalled choice gives way to the first agent this machine has", () => {
    setCatalog([byId("droid"), byId("pi")]);
    expect(preferredAgent("codex", has("pi"))?.id).toBe("pi");
    expect(preferredAgent(undefined, has("droid"))?.id).toBe("droid");
  });
  test("with nothing installed, the choice stands, then the catalog default", () => {
    setCatalog([byId("claude"), byId("codex")]);
    expect(preferredAgent("codex", has())?.id).toBe("codex");
    expect(preferredAgent(undefined, has())?.id).toBe(defaultAgent()?.id);
  });
});
