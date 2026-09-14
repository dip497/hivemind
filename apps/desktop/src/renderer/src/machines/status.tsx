/** How a machine's connection state looks everywhere it appears: dot, words, colour. */
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import type { MachineStatus } from "../../../shared/ipc";

const COLOR: Record<MachineStatus["state"], string> = {
  online: "var(--color-ok)",
  connecting: "var(--color-warn)",
  reconnecting: "var(--color-warn)",
  offline: "var(--color-err)",
  attention: "var(--color-err)",
  "no-hive": "var(--color-warn)",
  idle: "var(--color-fg3)",
};

export function statusColor(s: MachineStatus, enabled = true): string {
  return enabled ? COLOR[s.state] : "var(--color-fg3)";
}

/** Short words for a chip or row: the round trip when connected, otherwise what is going on. */
export function statusWords(s: MachineStatus, enabled = true): string {
  if (!enabled) return "off";
  switch (s.state) {
    case "online": return s.rttMs !== undefined ? `${s.rttMs} ms` : "online";
    case "connecting": return "connecting…";
    case "reconnecting": return "reconnecting…";
    case "offline": return "offline";
    case "attention": return "needs you";
    case "no-hive": return "no hive";
    case "idle": return "not connected";
  }
}

export function MachineDot({ status, enabled = true, size = 7 }: { status: MachineStatus; enabled?: boolean; size?: number }) {
  const busy = enabled && (status.state === "connecting" || status.state === "reconnecting");
  const hollow = !enabled || status.state === "idle" || status.state === "no-hive";
  const c = statusColor(status, enabled);
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 rounded-full ${busy ? "animate-pulse" : ""}`}
      style={{ width: size, height: size, background: hollow ? "transparent" : c, boxShadow: hollow ? `inset 0 0 0 1.5px ${c}` : undefined }}
    />
  );
}

/** A command the user runs once by hand (ssh host-key / login), with a copy button. */
export function CopyCommand({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex min-w-0 items-center gap-1 rounded-md bg-[var(--color-bg)] border border-[var(--color-line2)] pl-2 pr-1 py-1 font-mono text-[11.5px] text-[var(--color-fg)]">
      <span className="min-w-0 flex-1 truncate select-all" title={cmd}>{cmd}</span>
      <button
        onClick={() => { void navigator.clipboard.writeText(cmd).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}
        className="size-5 grid place-items-center rounded text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)] cursor-pointer"
        title="Copy"
        aria-label="copy command"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
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
      <span className="text-[11.5px] text-[var(--color-fg)]">
        ssh can't log in on its own{detail ? <>: <span className="text-[var(--color-fg2)]">{detail}</span></> : "."}{" "}
        {needsPassword
          ? "This machine asks for a password, and connections made for you never stop to ask. Give it the password once, or set up a key instead:"
          : "Run this once in a terminal to accept the host key or set up your key, then check again:"}
      </span>
      {needsPassword && onSetPassword && (
        <button onClick={onSetPassword} className="w-fit px-2.5 py-1 rounded-md text-[12px] font-medium text-white bg-[var(--color-brand)] hover:opacity-90 cursor-pointer">
          Set password…
        </button>
      )}
      <CopyCommand cmd={needsPassword ? `ssh-copy-id ${target}` : `ssh ${target}`} />
    </div>
  );
}
