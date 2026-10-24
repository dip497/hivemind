/** How a machine's connection state looks everywhere it appears: its mark and its words, from the
 *  app's status owner (`MACHINE_LOOKS`). */
import { useState } from "react";
import { Check, CloudServer, Container, Copy, Laptop, Monitor, Server } from "../components/icons";
import type { MachineInfo, MachineStatus } from "../../../shared/ipc";
import { Button } from "../components/ui/button";
import { MACHINE_LOOKS, MachineGlyph, machineLook } from "../workspace/status-look";

/** Short words for a chip or row: the round trip when connected, otherwise what is going on. */
export function statusWords(s: MachineStatus, enabled = true): string {
  if (enabled && s.state === "online" && s.rttMs !== undefined) return `${s.rttMs} ms`;
  return MACHINE_LOOKS[machineLook(s.state, enabled)].word;
}

/** A machine's mark. `named`: where no word stands beside it, the mark says its word itself. */
export function MachineDot({ status, enabled = true, size = 7, named = false }: { status: MachineStatus; enabled?: boolean; size?: number; named?: boolean }) {
  return <MachineGlyph look={machineLook(status.state, enabled)} size={size} named={named} />;
}

/** A command the user runs once by hand (ssh host-key / login), with a copy button. */
export function CopyCommand({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex min-w-0 items-center gap-1 rounded-md bg-[var(--color-bg)] border border-[var(--color-line2)] pl-2 pr-1 py-1 font-mono text-label text-[var(--color-fg)]">
      <span className="min-w-0 flex-1 truncate select-all" title={cmd}>{cmd}</span>
      <Button
        variant="ghost"
        size="icon-2xs"
        onClick={() => { void navigator.clipboard.writeText(cmd).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}
        title="Copy"
        aria-label="copy command"
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </span>
  );
}

/** What ssh needs from the user when a background connection cannot log in by itself. */
export function AttentionNote({ target, detail, needsPassword, onSetPassword }: {
  target: string;
  detail?: string;
  /** The host wants a password: `ssh <target>` by hand proves nothing, since that prompt is interactive. */
  needsPassword?: boolean;
  onSetPassword?: () => void;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5 rounded-lg border border-[color-mix(in_oklab,var(--color-err)_40%,transparent)] bg-[color-mix(in_oklab,var(--color-err)_8%,transparent)] p-2.5">
      <span className="text-label text-[var(--color-fg)]">
        ssh can't log in on its own{detail ? <>: <span className="text-[var(--color-fg2)]">{detail}</span></> : "."}{" "}
        {needsPassword
          ? "This machine asks for a password, and connections made for you never stop to ask. Give it the password once, or set up a key instead:"
          : "Run this once in a terminal to accept the host key or set up your key, then check again:"}
      </span>
      {needsPassword && onSetPassword && (
        <Button size="sm" onClick={onSetPassword} className="justify-self-start">
          Set password…
        </Button>
      )}
      <CopyCommand cmd={needsPassword ? `ssh-copy-id ${target}` : `ssh ${target}`} />
    </div>
  );
}

type Kind = NonNullable<MachineInfo["kind"]>;
const KIND_ICON: Record<Kind, typeof Server> = { laptop: Laptop, desktop: Monitor, server: Server, "virtual-machine": CloudServer, container: Container };
const KIND_WORDS: Record<Kind, string> = { laptop: "Laptop", desktop: "Desktop", server: "Server", "virtual-machine": "Virtual machine", container: "Container" };

/** The machine's own kind of computer, as it reported it; one that has not said looks like a
 *  screen when it is this computer and a server when it is elsewhere. */
export function MachineIcon({ kind, thisComputer = false, size }: { kind?: Kind; thisComputer?: boolean; size?: number }) {
  const Icon = kind ? KIND_ICON[kind] : thisComputer ? Monitor : Server;
  return <Icon size={size} data-machine-kind={kind ?? "unknown"} />;
}

/** "Laptop, Linux arm64": what a machine said about itself. */
export function machineFacts(kind?: Kind, platform?: string): string {
  const os = platform?.replace(/^linux-/, "Linux ").replace(/^darwin-/, "macOS ").replace(/^windows-/, "Windows ");
  return [kind ? KIND_WORDS[kind] : null, os].filter(Boolean).join(", ");
}
