/**
 * Agent registry — the single source of truth for every AI coding agent the app
 * can spawn (claude today; codex / gemini / opencode / … tomorrow). The UI
 * renders agents FROM this list, so adding a new one is a single entry here:
 * give it an id, label, the CLI `cmd` (+ any default args), and an icon. Every
 * surface (tool island, Layers panel, tile chrome, command surfaces) then shows
 * it with the right icon automatically.
 *
 * Icons are inline SVGs that inherit `currentColor`, so they theme correctly.
 * The Claude mark is Anthropic's official logo (from simple-icons).
 */
import type { ReactNode } from "react";

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
}

function ClaudeIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  );
}

/** Codex — clean geometric mark (the official OpenAI logo wasn't fetchable as a
 *  complete path; swap the registry `icon` to drop in the real logo later). */
function CodexIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
      <path d="M8 1.6 13.5 4.8v6.4L8 14.4 2.5 11.2V4.8z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
    </svg>
  );
}

/** opencode — its official logo's leading block glyph (downloaded), monochrome. */
function OpencodeIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="-3 6 30 30" fill="currentColor" className={className} aria-hidden>
      <path d="M18 30H6V18H18V30Z" opacity="0.65" />
      <path d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" />
    </svg>
  );
}

/** A generic agent mark for tools without a bundled logo yet (gemini/…). */
function GenericAgentIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
      <rect x="2.5" y="4" width="11" height="8.5" rx="2" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="6" cy="8" r="1" fill="currentColor" />
      <circle cx="10" cy="8" r="1" fill="currentColor" />
      <path d="M8 4V2M5.5 12.5v1M10.5 12.5v1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The registry. ADD A NEW AGENT HERE — that's the only change needed; every UI
 * surface reads from this list. (codex / gemini / opencode are scaffolded but
 * `enabled: false` until their spawn flow + logo are wired.)
 */
export const AGENTS: AgentDef[] = [
  { id: "claude", label: "Claude", cmd: "claude", icon: ClaudeIcon, enabled: true },
  // Codex: safe interactive default — works in the workspace, asks before risky
  // / out-of-sandbox actions (status detection handles the approval prompts).
  { id: "codex", label: "Codex", cmd: "codex", defaultArgs: ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"], icon: CodexIcon, enabled: true },
  // opencode: permission model is config-driven (opencode.json), so no default
  // flags. Note: its TUI has no CLI resume — reopen sessions via its in-app list.
  { id: "opencode", label: "opencode", cmd: "opencode", icon: OpencodeIcon, enabled: true },
  { id: "gemini", label: "Gemini", cmd: "gemini", icon: GenericAgentIcon, enabled: false },
];

const BY_ID = new Map(AGENTS.map((a) => [a.id, a]));

export function agentById(id: string): AgentDef | undefined {
  return BY_ID.get(id);
}

/** Resolve the agent that a PTY command line belongs to (first token match). */
export function agentForCmd(cmd: string | undefined): AgentDef | undefined {
  if (!cmd) return undefined;
  const bin = cmd.trim().split(/\s+/)[0]?.split("/").pop();
  return AGENTS.find((a) => a.cmd === bin);
}

/** Convenience: render an agent's icon by id (falls back to the generic mark). */
export function AgentIcon({ id, size, className }: { id: string; size?: number; className?: string }) {
  const a = agentById(id);
  return (a?.icon ?? GenericAgentIcon)({ size, className });
}
