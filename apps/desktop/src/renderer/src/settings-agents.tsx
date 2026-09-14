import { useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, Copy, ExternalLink, Store, Trash2, TriangleAlert } from "lucide-react";
import {
  BUILTIN_CATALOG, GENERIC_AGENT_ICON, defFromManifest, optionChoices,
  type AgentOption, type AgentProviderDef, type AgentWireEntry,
} from "@hivemind/agents";
import { patchSettings, useSettings } from "./settings-store";
import { notReady, useAgentEntries, useAgentPresence, setAgentDisabled, refreshAgentPresence, syncAgentPlugins } from "./agent-plugins";
import { useSettingsNavigate } from "./settings-panels";
import { SvgMark, useAgents, agentById } from "./agents";
import { preferredAgent } from "@hivemind/agents";

type Choices = Awaited<ReturnType<typeof window.hive.agentOptionChoices>>;

interface Card {
  id: string;
  def: AgentProviderDef | undefined;
  source: AgentWireEntry["source"];
  on: boolean;
  error: string | null;
}

const SOURCE_COPY: Record<string, string> = {
  builtin: "Built-in integration",
  user: "Added on this machine",
  repo: "From this repository",
};

function defOf(e: AgentWireEntry): AgentProviderDef | undefined {
  if (e.source === "builtin") return BUILTIN_CATALOG.find((d) => d.id === e.id);
  try { return defFromManifest(e.manifest); } catch { return undefined; }
}

/** One card per id; a later source shadows an earlier one, as the loader does. */
function useCards(): Card[] {
  const entries = useAgentEntries();
  const catalog = useAgents();
  // Memoised: a plugin's def is rebuilt from its manifest, and effects keyed on it
  // (option discovery, the install check) must not re-run on every settings edit.
  return useMemo(() => {
    if (!entries.length) {
      return catalog.map((a): Card => ({ id: a.id, def: a.def, source: "builtin", on: true, error: null }));
    }
    const byId = new Map<string, Card>();
    for (const e of entries) {
      // A broken later entry (a repo refused for a taken id) does not hide the working one.
      if (e.error && byId.get(e.id)?.def) continue;
      byId.set(e.id, { id: e.id, def: defOf(e), source: e.source, on: !e.disabled && !e.error, error: e.error });
    }
    return [...byId.values()];
  }, [entries, catalog]);
}

function useOptionChoices(def: AgentProviderDef): Choices | null {
  const [choices, setChoices] = useState<Choices | null>(null);
  useEffect(() => {
    let live = true;
    setChoices(null);
    const ask = window.hive.agentOptionChoices;
    if (!def.options?.length || !ask) { setChoices({}); return; }
    ask(def.id).catch(() => ({})).then((r) => { if (live) setChoices(r); });
    return () => { live = false; };
  }, [def]);
  return choices;
}

export function AgentsOverview() {
  const cards = useCards().filter((c) => c.def?.enabled || c.error);
  const go = useSettingsNavigate();
  const presence = useAgentPresence();
  const { defaultAgent: saved, autoInstall } = useSettings().agents;
  const defaultId = preferredAgent(saved, (d) => !notReady(presence, d.id)).id;
  const missing = (c: Card) => notReady(presence, c.id);
  const savedCard = saved && saved !== defaultId ? cards.find((c) => c.id === saved) : undefined;
  const ready = cards.filter((c) => c.on && !missing(c));
  const notInstalled = cards.filter((c) => c.on && missing(c));
  const off = cards.filter((c) => !c.on);
  const label = (c: Card) => c.def?.label ?? c.id;
  const state = (c: Card) => c.error ? "unavailable" : !c.on ? "off" : missing(c) ? "missing" : "on";
  // One line that says what to do next, not just what is wrong.
  const detail = (c: Card) => c.error ? c.error
    : presence[c.id]?.mismatch ? "Not installed · another program answers to that name"
    : missing(c) ? `Not installed · needs the ${c.def?.bin ?? c.id} command`
    : !c.on ? "Off" : SOURCE_COPY[c.source] ?? "";
  const row = (c: Card) => (
    <div key={c.id} className="agent-row" data-agent-card={c.id} data-state={state(c)}>
      <button className="agent-row-open" onClick={() => go(`agent:${c.id}`)}>
        <SvgMark icon={c.def?.icon ?? GENERIC_AGENT_ICON} size={20} />
        <span className="agent-row-text">
          <span className="agent-row-name">{label(c)}</span>
          <span className="agent-row-detail">{detail(c)}</span>
        </span>
      </button>
      {state(c) === "on" && (
        <button className="agent-default" data-default-choice={c.id} role="radio" aria-checked={c.id === defaultId}
          aria-label={c.id === defaultId ? `${label(c)} is the default` : `Make ${label(c)} the default`} title="Default agent"
          onClick={() => patchSettings("agents.defaultAgent", c.id)}>{c.id === defaultId ? "Default" : <span className="agent-default-dot" aria-hidden="true" />}</button>
      )}
      <ChevronRight className="agent-row-go" size={15} aria-hidden="true" />
    </div>
  );
  const group = (title: string, list: Card[], hint?: string) => list.length > 0 && (
    <section aria-label={title}>
      <div className="settings-section-heading"><h3>{title} · {list.length}</h3>{hint && <span>{hint}</span>}</div>
      <div className="agent-rows" role={list === ready ? "radiogroup" : undefined} aria-label={list === ready ? "Default agent" : undefined}>{list.map(row)}</div>
    </section>
  );
  return (
    <div className="settings-stack">
      {group("Installed", ready, "The default is what the toolbar button and ⌘\\ start")}
      {savedCard ? (
        <p role="status" className="settings-note warn">
          {label(savedCard)} is {savedCard.on ? "not installed" : "switched off"}, so {cards.find((c) => c.id === defaultId)?.def?.label ?? defaultId} starts instead.
        </p>
      ) : !ready.some((c) => c.id === defaultId) && (
        <p role="status" className="settings-note error">Your default agent is not ready on this machine. Pick another, or install it.</p>
      )}
      {group("Not installed", notInstalled, "Open one to see how to get it")}
      {group("Off", off)}
      <div className="settings-row" data-auto-install>
        <div><label htmlFor="agents-auto-install">Add agents found on this machine</label>
          <p>When a CLI from the plugin catalog is installed here, Hivemind adds its agent. Removing one keeps it removed.</p></div>
        <button id="agents-auto-install" className="settings-switch" role="switch" aria-checked={autoInstall}
          aria-label="Add agents found on this machine" onClick={() => patchSettings("agents.autoInstall", !autoInstall)}><span /></button>
      </div>
      <div className="settings-inline">
        <button className="settings-button" onClick={() => go("plugins")}><Store size={14} />Browse agents</button>
        <button className="settings-text-button" onClick={() => go("installed")}>Add one from a folder</button>
      </div>
    </div>
  );
}

export function AgentPage({ id }: { id: string }) {
  const card = useCards().find((c) => c.id === id);
  const presence = useAgentPresence();
  const defaultId = preferredAgent(useSettings().agents.defaultAgent, (d) => !notReady(presence, d.id)).id;
  if (!card) return <p className="settings-empty">There is no agent named {id}.</p>;
  const { def } = card;
  const label = def?.label ?? card.id;
  return (
    <div className="plugin-page" data-agent-detail={card.id}>
      <header className="plugin-head">
        <span className="plugin-mark"><SvgMark icon={def?.icon ?? GENERIC_AGENT_ICON} size={26} /></span>
        <div className="plugin-title">
          <p>{def && <><code>{def.bin}</code><span>·</span></>}{SOURCE_COPY[card.source] ?? card.source}</p>
        </div>
        {def?.enabled && card.on && !notReady(presence, card.id) && (card.id === defaultId
          ? <span className="agent-badge">Default</span>
          : <button className="settings-button" onClick={() => patchSettings("agents.defaultAgent", card.id)}>Make default</button>)}
        <button className="settings-switch" role="switch" aria-label={`Enable ${label}`} aria-checked={card.on}
          disabled={!!card.error} onClick={() => { void setAgentDisabled(card.id, card.on); }}><span /></button>
      </header>
      {card.error && <p role="status" className="settings-note error">{card.error}</p>}
      {def?.enabled && <Requirement def={def} />}
      {def && <Facts def={def} />}
      {def?.enabled && card.on && (
        <section className="plugin-section" aria-label="Launch options">
          <h3>Launch options</h3>
          <LaunchOptions def={def} />
        </section>
      )}
      {card.source === "user" && <RemoveAgent id={card.id} label={label} />}
    </div>
  );
}

function RemoveAgent({ id, label }: { id: string; label: string }) {
  const go = useSettingsNavigate();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <section className="plugin-section" aria-label="Remove">
    {!confirm ? <button className="settings-text-button danger" onClick={() => setConfirm(true)}><Trash2 size={13} />Remove {label}</button>
      : <div className="settings-remove-confirm">
        <p>Remove {label}? Hivemind will not add it again on its own. Its CLI stays installed.</p>
        {error && <p role="alert" className="settings-note error">{error}</p>}
        <div className="settings-actions">
          <button className="settings-button" onClick={() => setConfirm(false)}>Keep it</button>
          <button className="settings-button danger" onClick={() => void window.hive.removeAgent(id)
            .then(() => syncAgentPlugins()).then(() => go("agents"), (e: Error) => setError(e.message))}>Remove</button>
        </div>
      </div>}
  </section>;
}

type Verified = Awaited<ReturnType<typeof window.hive.verifyAgent>>;

/** Whether this machine has the agent's CLI, and where to get it if not. */
function Requirement({ def }: { def: AgentProviderDef }) {
  const [check, setCheck] = useState(0);
  const [found, setFound] = useState<Verified | null>(null);
  useEffect(() => {
    let live = true;
    setFound(null);
    const ask = window.hive.verifyAgent;
    if (!ask) return;
    ask(def.id).then((r) => { if (live) setFound(r); void refreshAgentPresence(); }, () => { if (live) setFound({ path: null }); });
    return () => { live = false; };
  }, [def, check]);
  const again = () => setCheck((n) => n + 1);
  if (!found) return <div className="agent-req" data-state="checking">Looking for <code>{def.bin}</code>…</div>;
  if (found.version) {
    return <div className="agent-req" data-state="ok"><Check size={14} /><span>Installed · {found.version}</span><code className="agent-req-path">{found.path}</code></div>;
  }
  return (
    <div className="agent-req" data-state={found.path ? "mismatch" : "missing"} role="status">
      <TriangleAlert size={14} />
      <div className="agent-req-body">
        <p>{found.path
          ? <>Found <code>{found.path}</code>, but it is not {def.label}: it did not answer <code>--version</code> like a CLI.</>
          : <>{def.label} is not installed. Hivemind looks for <code>{def.bin}</code> on your PATH.</>}</p>
        <div className="agent-req-actions">
          {def.install && <a className="settings-button primary" href={def.install.url} target="_blank" rel="noreferrer">Get {def.label}<ExternalLink size={13} /></a>}
          {def.install?.command && <CopyCommand command={def.install.command} />}
          <button className="settings-button" onClick={again}>Check again</button>
        </div>
      </div>
    </div>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button className="settings-button agent-req-command" title="Copy install command"
      onClick={() => { void navigator.clipboard.writeText(command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
      <code>{command}</code>{copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function Facts({ def }: { def: AgentProviderDef }) {
  const facts: [string, boolean][] = [
    def.caps.turnSignal ? ["Works as a worker for other agents", true] : ["Other agents cannot collect its replies", false],
    def.caps.resume !== "none" ? ["Picks up where it left off after a restart", true] : ["Starts fresh after a restart", false],
  ];
  return <ul className="agent-facts">{facts.map(([f, good]) => <li key={f} data-limit={good ? undefined : ""}>{f}</li>)}</ul>;
}

function LaunchOptions({ def }: { def: AgentProviderDef }) {
  const saved = useSettings().agents.options[def.id] ?? {};
  const choices = useOptionChoices(def);
  if (!def.options?.length) return <p className="settings-note agent-options-empty">{def.label} has nothing to set at launch.</p>;
  return (
    <div className="agent-options">
      {def.options.map((o) => (
        <OptionRow key={o.id} def={def} option={o} value={saved[o.id] ?? ""} found={choices ? choices[o.id] ?? null : undefined} />
      ))}
    </div>
  );
}

const MAX_SELECT = 24;

function OptionRow({ def, option: o, value, found }: {
  def: AgentProviderDef; option: AgentOption; value: string;
  /** undefined = still asking the CLI; null = it said nothing. */
  found: Choices[string] | null | undefined;
}) {
  const id = `agent-${def.id}-${o.id}`;
  const values = optionChoices(o, found?.values ?? []);
  const set = (v: string) => patchSettings(`agents.options.${def.id}.${o.id}`, v);
  const unset = o.default ? `${o.default} (Hivemind default)` : `${def.label} decides`;
  const source = found === undefined ? `Asking ${def.bin}…`
    : found?.from === "list" ? `Listed by ${def.bin} ${o.list!.args.join(" ")}`
    : found?.from === "help" ? `From ${def.bin} --help`
    : found?.error ?? `${def.bin} does not list these; type any value`;
  const asSelect = values.length > 0 && values.length <= MAX_SELECT && (!value || values.includes(value));
  return (
    <div className="settings-row" data-agent-option-row={o.id}>
      <div><label htmlFor={id}>{o.label}</label><p>{source}</p></div>
      {asSelect ? (
        <select id={id} value={value} onChange={(e) => set(e.target.value)}>
          <option value="">{unset}</option>
          {values.filter((v) => v !== o.default).map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      ) : (
        <>
          <input id={id} className="agent-option-input" list={`${id}-values`} value={value} placeholder={unset}
            spellCheck={false} autoComplete="off" onChange={(e) => set(e.target.value.trim())} />
          <datalist id={`${id}-values`}>{values.map((v) => <option key={v} value={v} />)}</datalist>
        </>
      )}
    </div>
  );
}
