import { afterEach, describe, expect, test } from "bun:test";
import {
  BUILTIN_CATALOG, getCatalog, setCatalog, subscribeCatalog,
  agentById, agentForCmd, identifyProvider, defaultAgent, preferredAgent, spawnableAgents, workerAgents,
} from "../src/catalog.js";
import { providers } from "../src/node.js";
import type { AgentProviderDef } from "../src/types.js";

const acme: AgentProviderDef = {
  id: "acme", label: "Acme", bin: "acme", aliases: ["acme-cli"], enabled: true,
  caps: {
    promptDelivery: "typed", turnSignal: false, resume: "none", supervise: "human",
    blockedDetection: false,
  },
  icon: { viewBox: "0 0 1 1", body: "" },
  detect: () => "idle",
};

// Global state: every test restores the compiled-in set.
afterEach(() => setCatalog(BUILTIN_CATALOG));

describe("live catalog", () => {
  test("setCatalog re-resolves every lookup", () => {
    expect(agentById("acme")).toBeUndefined();
    setCatalog([...BUILTIN_CATALOG, acme]);
    expect(agentById("acme")?.label).toBe("Acme");
    expect(agentForCmd("/usr/bin/acme --x")?.id).toBe("acme");
    expect(identifyProvider("acme-cli")?.id).toBe("acme");
    expect(spawnableAgents().map((d) => d.id)).toContain("acme");
    setCatalog(BUILTIN_CATALOG);
    expect(agentById("acme")).toBeUndefined();
    expect(agentForCmd("acme")).toBeUndefined();
    expect(identifyProvider("acme-cli")).toBeUndefined();
  });

  test("removing a provider removes its alias and binary too", () => {
    expect(identifyProvider("claude-code")?.id).toBe("claude");
    setCatalog(BUILTIN_CATALOG.filter((d) => d.id !== "claude"));
    expect(agentById("claude")).toBeUndefined();
    expect(agentForCmd("claude")).toBeUndefined();
    expect(identifyProvider("claude-code")).toBeUndefined();
  });

  test("subscribers are notified so React can re-render", () => {
    let fired = 0;
    const off = subscribeCatalog(() => { fired++; });
    setCatalog([...BUILTIN_CATALOG, acme]);
    setCatalog(BUILTIN_CATALOG);
    expect(fired).toBe(2);
    off();
    setCatalog([...BUILTIN_CATALOG, acme]);
    expect(fired).toBe(2); // unsubscribed
  });

  test("the daemon's provider list follows the live catalog", () => {
    expect(providers().map((p) => p.id)).toContain("claude");
    setCatalog(BUILTIN_CATALOG.filter((d) => d.id !== "claude"));
    expect(providers().map((p) => p.id)).not.toContain("claude");
  });
});

describe("defaultAgent never throws", () => {
  test("falls back when nothing is enabled", () => {
    setCatalog(BUILTIN_CATALOG.map((d) => ({ ...d, enabled: false })));
    expect(spawnableAgents()).toEqual([]);
    expect(workerAgents()).toEqual([]);
    expect(() => defaultAgent()).not.toThrow();
    expect(defaultAgent().id).toBe(BUILTIN_CATALOG[0]!.id);
  });

  test("falls back when the catalog is empty", () => {
    setCatalog([]);
    expect(getCatalog()).toEqual([]);
    expect(() => defaultAgent()).not.toThrow();
    expect(defaultAgent().enabled).toBe(true); // a compiled-in spawnable one
  });

  test("prefers an enabled provider over the first entry", () => {
    setCatalog([{ ...acme, enabled: false }, { ...acme, id: "beta", bin: "beta", enabled: true }]);
    expect(defaultAgent().id).toBe("beta");
  });
});

describe("preferredAgent", () => {
  const has = (...ids: string[]) => (d: { id: string }) => ids.includes(d.id);
  test("the user's choice wins when it can run here", () => {
    expect(preferredAgent("codex", has("claude", "codex")).id).toBe("codex");
  });
  test("an uninstalled choice gives way to the first agent this machine has", () => {
    expect(preferredAgent("codex", has("pi")).id).toBe("pi");
    expect(preferredAgent(undefined, has("droid", "pi")).id).toBe("droid");
  });
  test("with nothing installed, the choice stands, then the catalog default", () => {
    expect(preferredAgent("codex", has()).id).toBe("codex");
    expect(preferredAgent(undefined, has()).id).toBe(defaultAgent().id);
  });
});
