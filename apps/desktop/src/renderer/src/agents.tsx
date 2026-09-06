/**
 * The UI's view of the agent catalog (@hivemind/agents). Every surface — tool
 * island, frame launcher, Layers rail, tile chrome, pickers — renders agents
 * FROM the catalog: adding a provider there adds it here. No provider is named
 * in this file; the icon is the provider def's own SVG mark, rendered
 * generically (inner markup is an app-owned constant, never user input).
 */
import type { ReactNode } from "react";
import {
  CATALOG, GENERIC_AGENT_ICON, agentById as catalogAgentById, agentForCmd as catalogAgentForCmd,
  type AgentIcon as AgentIconDef, type AgentProviderDef,
} from "@hivemind/agents";

export interface AgentDef {
  /** Stable id (also the LayerKind / detection key). */
  id: string;
  /** Human label shown in tooltips / pickers. */
  label: string;
  /** The CLI binary to spawn. */
  cmd: string;
  /** Default args (permission flags etc. are layered on at spawn time). */
  defaultArgs?: string[];
  /** Icon renderer — inherits currentColor. */
  icon: (props: { size?: number; className?: string }) => ReactNode;
  /** Whether this agent is wired up / spawnable today. */
  enabled: boolean;
  /** The catalog def — capabilities, detector, note. */
  def: AgentProviderDef;
}

/** Render a catalog icon: viewBox + root attrs + inner markup, theming via currentColor. */
function SvgMark({ icon, size = 16, className }: { icon: AgentIconDef; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={icon.viewBox}
      className={className}
      aria-hidden
      {...(icon.attrs ?? {})}
      dangerouslySetInnerHTML={{ __html: icon.body }}
    />
  );
}

function toAgentDef(def: AgentProviderDef): AgentDef {
  return {
    id: def.id,
    label: def.label,
    cmd: def.bin,
    defaultArgs: def.defaultArgs,
    icon: ({ size, className }) => <SvgMark icon={def.icon} size={size} className={className} />,
    enabled: def.enabled,
    def,
  };
}

/** The registry, in catalog order. */
export const AGENTS: AgentDef[] = CATALOG.map(toAgentDef);

const BY_ID = new Map(AGENTS.map((a) => [a.id, a]));

export function agentById(id: string): AgentDef | undefined {
  return BY_ID.get(id) ?? (catalogAgentById(id) ? toAgentDef(catalogAgentById(id)!) : undefined);
}

/** Resolve the agent that a PTY command line belongs to (exact binary match). */
export function agentForCmd(cmd: string | undefined): AgentDef | undefined {
  const d = catalogAgentForCmd(cmd);
  return d ? BY_ID.get(d.id) : undefined;
}

/** Convenience: render an agent's icon by id (falls back to the generic mark). */
export function AgentIcon({ id, size, className }: { id: string; size?: number; className?: string }) {
  const a = agentById(id);
  return <SvgMark icon={a?.def.icon ?? GENERIC_AGENT_ICON} size={size} className={className} />;
}
