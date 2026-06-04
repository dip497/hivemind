/**
 * RemoteConnectModal — attach an SSH host to a frame. Two steps:
 *   1. Connect form (host / user / port / optional key path) → sshConnect probe.
 *   2. SFTP folder browser starting at the remote home → pick a directory.
 * On pick it returns the full `ssh://user@host:port/path` uri; the caller binds
 * it as the frame's workspacePath (every tile in the frame then runs remote).
 */
import { useEffect, useRef, useState } from "react";
import { Server, Folder, ChevronRight, Loader2, ArrowLeft, HardDriveDownload, X, Plug } from "lucide-react";
import type { RemoteDirEntry, SavedHost } from "../../../shared/ipc";
import { formatRemote, posixJoin } from "../../../shared/remote-uri";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called with the chosen ssh:// uri when the user picks a folder. */
  onPick: (uri: string) => void;
}

export function RemoteConnectModal({ open, onClose, onPick }: Props) {
  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const [port, setPort] = useState("22");
  const [keyPath, setKeyPath] = useState("");
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<"form" | "browse">("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [entries, setEntries] = useState<RemoteDirEntry[]>([]);
  const [remember, setRemember] = useState(true);
  const [saved, setSaved] = useState<SavedHost[]>([]);
  const firstInput = useRef<HTMLInputElement>(null);

  // Reset on open; focus the host field; load saved connections.
  useEffect(() => {
    if (!open) return;
    setPhase("form"); setError(null); setBusy(false);
    setEntries([]); setCwd(""); setPassword(""); setRemember(true);
    window.hive.sshSavedHosts().then(setSaved).catch(() => setSaved([]));
    const t = setTimeout(() => firstInput.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const portNum = Number(port) || 22;
  // authority-only uri (no path) used for the connect probe + dir listings.
  const baseUri = () => formatRemote({ host: host.trim(), port: portNum, user: user.trim() || null, path: "/" });

  async function connect() {
    if (!host.trim()) { setError("host is required"); return; }
    setBusy(true); setError(null);
    try {
      const { home } = await window.hive.sshConnect(baseUri(), {
        username: user.trim() || undefined,
        privateKeyPath: keyPath.trim() || undefined,
        password: password || undefined,
      }, remember);
      await list(home);
      setPhase("browse");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Reconnect a saved host with its stored (keychain) credentials.
  async function connectSaved(h: SavedHost) {
    setBusy(true); setError(null);
    try {
      const r = await window.hive.sshConnectSaved(h.hostId);
      setHost(r.host); setUser(r.user); setPort(String(r.port));
      await list(r.home);
      setPhase("browse");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function forget(hostId: string) {
    await window.hive.sshForgetHost(hostId).catch(() => {});
    setSaved((s) => s.filter((h) => h.hostId !== hostId));
  }

  async function list(dir: string) {
    setBusy(true); setError(null);
    try {
      const res = await window.hive.sshListDir(baseUri(), dir);
      setCwd(res.dir);
      setEntries(res.entries.filter((e) => e.isDir));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function pick() {
    onPick(formatRemote({ host: host.trim(), port: portNum, user: user.trim() || null, path: cwd }));
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-[460px] max-w-[92vw] rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] shadow-2xl overflow-hidden">
        <header className="flex items-center gap-2 px-4 h-11 border-b border-[var(--color-line)]">
          <Server size={15} className="text-[var(--color-brand)]" />
          <span className="text-[13px] font-semibold text-[var(--color-fg)]">Attach remote (SSH)</span>
          {busy && <Loader2 size={14} className="ml-auto animate-spin text-[var(--color-fg3)]" />}
        </header>

        {phase === "form" ? (
          <div className="p-4 grid gap-3">
            {saved.length > 0 && (
              <div className="grid gap-1">
                <span className="u-eyebrow">Saved</span>
                <div className="grid gap-1">
                  {saved.map((h) => (
                    <div key={h.hostId} className="group flex items-center gap-2 rounded-md border border-[var(--color-line2)] bg-[var(--color-bg3)] px-2 py-1.5">
                      <Server size={13} className="shrink-0 text-[var(--color-brand)]" />
                      <button
                        onClick={() => connectSaved(h)}
                        disabled={busy}
                        className="flex-1 text-left min-w-0 cursor-pointer disabled:opacity-50"
                        title={`Connect ${h.hostId}`}
                      >
                        <span className="block text-[12px] text-[var(--color-fg)] truncate">{h.user ? `${h.user}@` : ""}{h.host}{h.port !== 22 ? `:${h.port}` : ""}</span>
                        <span className="block text-[10px] text-[var(--color-fg3)]">{h.hasPassword ? "password saved" : h.hasKey ? "key" : "agent"}</span>
                      </button>
                      <Plug size={12} className="shrink-0 text-[var(--color-fg3)] group-hover:text-[var(--color-fg)]" />
                      <button onClick={() => forget(h.hostId)} aria-label="forget host" title="Forget" className="shrink-0 text-[var(--color-fg3)] hover:text-[var(--color-err)] cursor-pointer"><X size={13} /></button>
                    </div>
                  ))}
                </div>
                <div className="my-1 border-t border-[var(--color-line2)]" />
              </div>
            )}
            <div className="grid grid-cols-[1fr_88px] gap-2">
              <label className="grid gap-1">
                <span className="u-eyebrow">Host</span>
                <input
                  ref={firstInput}
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") connect(); }}
                  placeholder="build.example.com"
                  className="bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-md px-2.5 py-1.5 text-[13px] text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-1 focus:ring-[var(--color-brand)]"
                />
              </label>
              <label className="grid gap-1">
                <span className="u-eyebrow">Port</span>
                <input
                  value={port}
                  onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
                  className="bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-md px-2.5 py-1.5 text-[13px] text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-1 focus:ring-[var(--color-brand)]"
                />
              </label>
            </div>
            <label className="grid gap-1">
              <span className="u-eyebrow">User</span>
              <input
                value={user}
                onChange={(e) => setUser(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") connect(); }}
                placeholder={`$USER (or from ~/.ssh)`}
                className="bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-md px-2.5 py-1.5 text-[13px] text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-1 focus:ring-[var(--color-brand)]"
              />
            </label>
            <label className="grid gap-1">
              <span className="u-eyebrow">Password <span className="lowercase tracking-normal text-[var(--color-fg3)]">(or use a key below)</span></span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") connect(); }}
                placeholder="••••••••"
                autoComplete="off"
                className="bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-md px-2.5 py-1.5 text-[13px] text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-1 focus:ring-[var(--color-brand)]"
              />
            </label>
            <label className="grid gap-1">
              <span className="u-eyebrow">Private key path <span className="lowercase tracking-normal text-[var(--color-fg3)]">(optional — agent tried first)</span></span>
              <input
                value={keyPath}
                onChange={(e) => setKeyPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") connect(); }}
                placeholder="~/.ssh/id_ed25519"
                className="bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-md px-2.5 py-1.5 text-[13px] font-mono text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-1 focus:ring-[var(--color-brand)]"
              />
            </label>
            {error && <p className="text-[11.5px] text-[var(--color-err)] break-words">{error}</p>}
            <label className="flex items-center gap-2 text-[11.5px] text-[var(--color-fg2)] cursor-pointer select-none">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="accent-[var(--color-brand)]" />
              Remember this connection {password ? "(password in OS keychain)" : ""}
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={onClose} className="px-3 py-1.5 text-[12px] text-[var(--color-fg2)] hover:text-[var(--color-fg)] rounded-md cursor-pointer">Cancel</button>
              <button
                onClick={connect}
                disabled={busy || !host.trim()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-white bg-[var(--color-brand)] rounded-md hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Server size={13} />}
                Connect
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col">
            <div className="flex items-center gap-2 px-3 h-9 border-b border-[var(--color-line2)] text-[11.5px]">
              <button onClick={() => setPhase("form")} aria-label="back" className="text-[var(--color-fg3)] hover:text-[var(--color-fg)] cursor-pointer"><ArrowLeft size={14} /></button>
              <button onClick={() => list(posixJoin(cwd, ".."))} className="text-[var(--color-fg2)] hover:text-[var(--color-fg)] cursor-pointer">..</button>
              <span className="font-mono text-[var(--color-fg2)] truncate" title={cwd}>{cwd}</span>
            </div>
            <div className="max-h-[260px] overflow-y-auto p-1">
              {entries.length === 0 ? (
                <div className="px-3 py-6 text-center text-[11.5px] text-[var(--color-fg2)]">{busy ? "Loading…" : "No sub-folders here."}</div>
              ) : (
                entries.map((e) => (
                  <button
                    key={e.name}
                    onClick={() => list(posixJoin(cwd, e.name))}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-[12px] text-[var(--color-fg2)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)] cursor-pointer"
                  >
                    <Folder size={14} className="shrink-0 text-[var(--color-fg3)]" />
                    <span className="truncate flex-1">{e.name}</span>
                    <ChevronRight size={13} className="shrink-0 text-[var(--color-fg3)]" />
                  </button>
                ))
              )}
            </div>
            {error && <p className="px-3 py-1 text-[11.5px] text-[var(--color-err)] break-words">{error}</p>}
            <div className="flex items-center justify-end gap-2 px-3 py-2.5 border-t border-[var(--color-line2)]">
              <span className="mr-auto text-[11px] text-[var(--color-fg3)] font-mono truncate">use: {cwd}</span>
              <button
                onClick={pick}
                disabled={!cwd}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-white bg-[var(--color-brand)] rounded-md hover:opacity-90 disabled:opacity-40 cursor-pointer"
              >
                <HardDriveDownload size={13} /> Use this folder
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
