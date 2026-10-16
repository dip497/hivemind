/**
 * Which agent to start, from the agents installed here and ready: the default first. One list for
 * every place that starts one, so New agent and a job handed to an agent offer the same agents.
 */
import { useState } from "react";
import { preferredAgent } from "@hivemind/agents";
import { AgentIcon, useAgents, type AgentDef } from "./agents";
import { notReady, useAgentPresence } from "./agent-plugins";
import { useSettings } from "./settings-store";
import { Blocks, ChevronDown } from "./components/icons";
import { Button } from "./components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";

/** The agents ready here, the default one first, and which that is. */
export function useReadyAgents(): { ordered: AgentDef[]; first: string | undefined } {
  const presence = useAgentPresence();
  const chosen = useSettings().agents.defaultAgent;
  const ready = useAgents().filter((a) => a.enabled && !notReady(presence, a.id));
  const first = preferredAgent(chosen, (d) => !notReady(presence, d.id))?.id;
  return { ordered: [...ready].sort((a, b) => Number(b.id === first) - Number(a.id === first)), first };
}

/** Settings ▸ Agents, where one is got. */
export const getAnAgent = () => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "agents" } }));

/** A button that starts the agent chosen from its menu with `work` as its first prompt. */
export function StartAgentWith({ label, work, ...rest }: { label: string; work: string; [data: `data-${string}`]: string | boolean }) {
  const [open, setOpen] = useState(false);
  const { ordered, first } = useReadyAgents();
  const start = (agent: string) => window.dispatchEvent(new CustomEvent("hivemind:spawn-agent", { detail: { agent, work } }));
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" {...rest}>{label}<ChevronDown /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[220px]" data-start-agent-with>
        {ordered.map((a) => (
          <DropdownMenuItem key={a.id} onSelect={() => start(a.id)} data-start-agent-choice={a.id}>
            <AgentIcon id={a.id} size={16} />{a.label}
            {a.id === first && <DropdownMenuShortcut>default</DropdownMenuShortcut>}
          </DropdownMenuItem>
        ))}
        {ordered.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={getAnAgent}><Blocks />Get more agents…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
