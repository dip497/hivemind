// Agents (the Android app's AgentsScreen): every agent, by machine and workspace, with a dot for its
// state, what it is doing and for how long. Tapped, it opens.

import type { App } from "./app.js";
import { Keyed, h, pill } from "./dom.js";
import type { Agent, Overview } from "./types.js";
import { ago, stateLabel } from "./words.js";

type Row = { key: string; machine: string } | { key: string; workspace: string } | { key: string; agent: Agent };

export class Agents {
  readonly el = h("section", { class: "screen", "data-screen": "agents" });
  private readonly list = h("div", { "data-agents": "" });
  private readonly none = h("p", { class: "quiet", hidden: true }, "No agents on your devices yet.");
  private readonly rows: Keyed<Row>;

  constructor(private readonly app: App) {
    const start = pill("Start", () => (location.hash = "start"), "compact", { "data-start": "" });
    this.el.append(h("h1", { class: "title" }, "Agents", start), this.none, this.list);
    this.rows = new Keyed(this.list, (r) => r.key, (r) => ("agent" in r ? sigOf(r.agent) : r.key), (r) => this.row(r));
  }

  show(o: Overview): void {
    // By machine, then workspace, each in the order the computer lists it.
    const machines = new Map<string, Map<string, Agent[]>>();
    for (const a of o.agents) {
      const workspaces = machines.get(a.machine) ?? machines.set(a.machine, new Map()).get(a.machine)!;
      (workspaces.get(a.workspace) ?? workspaces.set(a.workspace, []).get(a.workspace)!).push(a);
    }
    const rows: Row[] = [];
    for (const [machine, workspaces] of machines) {
      rows.push({ key: `m:${machine}`, machine });
      for (const [id, agents] of workspaces) {
        rows.push({ key: `w:${machine}/${id}`, workspace: agents[0]!.name });
        for (const agent of agents) rows.push({ key: `a:${agent.tile}`, agent });
      }
    }
    this.rows.set(rows);
    this.none.hidden = o.agents.length > 0;
    // Each breathing dot is a layer the browser recomposes on every change: past a few, still.
    const still = o.working > STILL_PAST;
    if (this.list.hasAttribute("data-still") !== still) this.list.toggleAttribute("data-still", still);
  }

  private row(r: Row): HTMLElement {
    if ("machine" in r) return h("h2", { class: "machine" }, r.machine);
    if ("workspace" in r) return h("h3", { class: "workspace mono" }, r.workspace);
    const a = r.agent;
    const waits = a.state === "waiting";
    const row = h("button", { type: "button", class: "agent", "data-agent": a.tile, "data-state": a.state, "data-waiting": a.waiting?.kind },
      h("span", { class: "dot", "data-state": a.state }),
      h("span", { class: "col" },
        h("span", { class: "name" }, a.agent),
        h("span", { class: `status mono${waits ? " waits" : ""}` }, [stateLabel(a.state), a.program?.label].filter(Boolean).join(" · "))),
      h("span", { class: "age mono", "data-since": a.since }, ago(a.since)));
    row.addEventListener("click", () => this.app.open(a.tile));
    return row;
  }
}

/** Working agents past which their dots stop breathing. */
const STILL_PAST = 40;

const sigOf = (a: Agent) => JSON.stringify([a.agent, a.state, a.since, a.program?.label, a.waiting?.kind]);
