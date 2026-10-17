import { AGENT_TILE_KIND } from "@hivemind/workspace-doc/shapes";
import { Terminal } from "../components/icons";
import { tileName } from "@hivemind/workspace-doc/tile-list";
import { defaultShell } from "../canvas-persistence";
import { identifyAgent } from "../agent-state";
import type { TilePlugin, PinRect } from "./api";

export type TerminalTileData = {
  tileId: string;
  cwd: string;
  cmd: string;
  args?: string[];
  /** An existing daemon session to show instead of the tile's own. */
  session?: string;
  label?: string;
  name?: string;
  /** The name alone, without the task: what a rename edits. */
  given?: string;
  onRename?: (id: string, name: string) => void;
  onOpenInBrowser?: (url: string) => void;
  onOpenInEditor?: (path: string) => void;
  onClose?: () => void;
  pinned?: boolean;
  onTogglePin?: (id: string, rect: PinRect) => void;
  /** Its layout says its agent sleeps. */
  sleeping?: boolean;
  /** Absent where it cannot sleep: a shell, a session started elsewhere. */
  onSleep?: () => Promise<void>;
  onWake: () => Promise<void>;
};

/** Auto-derive a short tile name from the command. Uses identifyAgent for known
 *  agents (claude, codex, opencode, …), falls back to the cmd basename. */
export function autoNameFromCmd(cmd: string): string {
  const agent = identifyAgent(cmd);
  if (agent) return agent;
  return cmd.split("/").pop()?.split(/\s+/)[0] ?? "terminal";
}

/** An agent's or a shell's session. */
export const terminalTile: TilePlugin<TerminalTileData> = {
  surface: "terminal",
  name: "terminal",
  kinds: {
    [AGENT_TILE_KIND]: { size: { width: 1100, height: 740 }, pixelExact: true, wholePixels: true, glyph: "✦" },
    shell: {
      size: { width: 1200, height: 820 }, pixelExact: true, wholePixels: true, title: "Terminal", icon: Terminal, glyph: "›_", category: "code",
      create: (opts, ordinal) => opts.session
        ? { cmd: opts.session.cmd, args: opts.session.args, label: opts.session.label, session: opts.session.id }
        : { ...defaultShell(), label: ordinal((n) => `shell #${n}`) },
    },
  },
  runsUnseen: true,
  data: (t, s, h) => {
    const cmd = t.cmd ?? defaultShell().cmd;
    const args = t.args ?? defaultShell().args;
    return {
      tileId: t.id, cwd: s.zoneRepo ?? s.cwd, cmd, args, label: t.label, ...(t.session ? { session: t.session } : {}),
      // The host reports a title only when what the agent says it is doing changes,
      // so this rebuilds one tile's body now and then, not on every spinner frame.
      name: tileName(h.tileNames, h.agentTitles, t) ?? autoNameFromCmd(cmd),
      given: h.tileNames[t.id] ?? t.label,
      onRename: h.renameTile,
      onOpenInBrowser: (url: string) => h.openUrlInBrowser(t.id, url),
      onOpenInEditor: (path: string) => h.openFileFromTerminal(t.id, path),
      onClose: s.onClose,
      ...s.pin,
      ...(t.sleeping ? { sleeping: true } : {}),
      ...(t.kind === AGENT_TILE_KIND && !t.session ? { onSleep: () => h.sleepTile(t.id) } : {}),
      onWake: () => h.wakeTile(t.id),
    };
  },
  lazy: true,
  body: () => import("./terminal-body"),
};
