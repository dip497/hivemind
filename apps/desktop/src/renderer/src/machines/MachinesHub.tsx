/**
 * Machines — every saved ssh machine with its live state, adding one, and choosing where a
 * frame runs (machine → folder). The list is the same one `hive machine` edits.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Folder, Loader2, MoreHorizontal, Plus, RefreshCw, Server } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import type { MachineInfo, RemoteDirEntry } from "../../../shared/ipc";
import { machineUri, posixJoin } from "../../../shared/remote-uri";
import { errText, statusOf, useMachines, type MachinesRequest } from "./store";
import { AttentionNote, MachineDot, statusWords } from "./status";

type View = { kind: "list" } | { kind: "add" } | { kind: "browse"; machine: MachineInfo };

const CHECK_AFTER_MS = 60_000;
const CHECK_PARALLEL = 4;
const input = "w-full bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-md px-2.5 py-1.5 text-[13px] text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-1 focus:ring-[var(--color-brand)]";
const primary = "inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-white bg-[var(--color-brand)] rounded-md hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer";
const quiet = "px-3 py-1.5 text-[12px] text-[var(--color-fg2)] hover:text-[var(--color-fg)] rounded-md cursor-pointer";

export function MachinesHub({ request, onClose, onPick }: {
  request: MachinesRequest | null;
  onClose: () => void;
  /** A folder was chosen for `request.frameId`. */
  onPick: (frameId: string, uri: string) => void;
}) {
  const snap = useMachines();
  const [view, setView] = useState<View>({ kind: "list" });
  const picking = request?.kind === "pick" ? request : null;

  // Which view this request opens on. Only the request moves it: a machine added or checked
  // mid-flow must not throw the user back to the list.
  useEffect(() => {
    if (!request) return;
    const m = request.kind === "pick" && request.machineId ? snap.machines.find((x) => x.id === request.machineId) : undefined;
    setView(m ? { kind: "browse", machine: m } : request.kind === "add" ? { kind: "add" } : { kind: "list" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  // Refresh machines nobody has looked at lately, a few at a time, once per opening — and only once the
  // list has arrived (the store may still be cold when the dialog opens). Connected ones report
  // themselves; a host that needs a login waits for the person, since re-probing only piles up failed logins.
  const refreshed = useRef<MachinesRequest | null>(null);
  useEffect(() => {
    if (!request) { refreshed.current = null; return; }
    if (refreshed.current === request || snap.machines.length === 0) return;
    refreshed.current = request;
    const now = Date.now();
    const due = snap.machines.filter((x) => {
      const s = statusOf(snap, x.hostId);
      return x.enabled && s.rttMs === undefined && s.state !== "attention" && s.state !== "reconnecting" && now - s.at > CHECK_AFTER_MS;
    });
    const next = async (): Promise<void> => {
      const x = due.shift();
      if (!x) return;
      await window.hive.machineCheck(x.id).catch(() => {});
      return next();
    };
    for (let i = 0; i < CHECK_PARALLEL; i++) void next();
  }, [request, snap]);

  const title = view.kind === "add" ? "Add a machine" : view.kind === "browse" ? view.machine.label : picking ? "Run this frame on…" : "Machines";

  return (
    <Dialog open={!!request} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        className="sm:max-w-[560px] p-0 gap-0 overflow-hidden grid-cols-[minmax(0,1fr)]"
        // Escape in an inline field cancels that field, not the dialog.
        onEscapeKeyDown={(e) => { if ((e.target as HTMLElement | null)?.dataset?.escapeLocal !== undefined) e.preventDefault(); }}
      >
        <header className="flex items-center gap-2 px-4 h-12 border-b border-[var(--color-line)]">
          {view.kind !== "list" && !(picking?.machineId && view.kind === "browse") && (
            <button onClick={() => setView({ kind: "list" })} aria-label="back" className="size-6 grid place-items-center rounded text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)] cursor-pointer"><ArrowLeft size={14} /></button>
          )}
          <Server size={15} className="text-[var(--color-brand)]" />
          <DialogTitle className="text-[13.5px] font-semibold text-[var(--color-fg)]">{title}</DialogTitle>
        </header>
        {view.kind === "list" && (
          <MachineList
            picking={!!picking}
            onChoose={(m) => setView({ kind: "browse", machine: m })}
            onAdd={() => setView({ kind: "add" })}
          />
        )}
        {view.kind === "add" && (
          <AddMachine
            initialTarget={request?.kind === "add" ? request.target : undefined}
            onCancel={() => (request?.kind === "add" ? onClose() : setView({ kind: "list" }))}
            onAdded={(m) => (picking ? setView({ kind: "browse", machine: m }) : setView({ kind: "list" }))}
          />
        )}
        {view.kind === "browse" && (
          <FolderPicker
            machine={view.machine}
            onPick={(uri) => { if (picking) onPick(picking.frameId, uri); onClose(); }}
            actionLabel={picking ? "Open here" : "Done"}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function MachineList({ picking, onChoose, onAdd }: { picking: boolean; onChoose: (m: MachineInfo) => void; onAdd: () => void }) {
  const snap = useMachines();
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [askPassword, setAskPassword] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const run = async (m: MachineInfo, what: string, fn: () => Promise<unknown>) => {
    setMenu(null);
    setBusy((b) => ({ ...b, [m.id]: what }));
    setErrors((e) => { const { [m.id]: _drop, ...rest } = e; return rest; });
    try { await fn(); } catch (e) { setErrors((x) => ({ ...x, [m.id]: errText(e).replace(/^\[\w+\] /, "") })); }
    setBusy(({ [m.id]: _drop, ...rest }) => rest);
  };

  return (
    <div className="flex flex-col">
      {snap.catalogError && (
        <p className="mx-4 mt-3 text-[11.5px] text-[var(--color-err)]">machines.json could not be read: {snap.catalogError}</p>
      )}
      {snap.machines.length === 0 ? (
        <div className="px-6 py-8 grid gap-3 place-items-center text-center">
          <Server size={22} className="text-[var(--color-fg3)]" />
          <p className="text-[12.5px] text-[var(--color-fg2)] max-w-[360px] leading-relaxed">
            Add a computer you can reach with <span className="font-mono">ssh</span>. Your keys, agent and <span className="font-mono">~/.ssh/config</span> are used as they are;
            terminals there keep running when the connection drops or this app closes.
          </p>
          <button onClick={onAdd} className={primary}><Plus size={13} /> Add a machine</button>
        </div>
      ) : (
        <ul className="max-h-[420px] overflow-y-auto overflow-x-hidden p-2 grid grid-cols-[minmax(0,1fr)] gap-1" aria-label="machines">
          {snap.machines.map((m) => {
            const s = statusOf(snap, m.hostId);
            const doing = busy[m.id];
            return (
              <li key={m.id} className="group min-w-0 rounded-lg border border-transparent hover:border-[var(--color-line2)] hover:bg-[var(--color-bg3)] transition-colors">
                <div className="flex items-center gap-2.5 px-2.5 py-2">
                  <MachineDot status={s} enabled={m.enabled} size={8} />
                  {renaming?.id === m.id ? (
                    <input
                      autoFocus
                      data-escape-local=""
                      aria-label={`rename ${m.label}`}
                      value={renaming.draft}
                      onChange={(e) => setRenaming({ id: m.id, draft: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setRenaming(null);
                        if (e.key === "Enter") { const d = renaming.draft; setRenaming(null); void run(m, "renaming", () => window.hive.machineUpdate(m.id, { label: d })); }
                      }}
                      onBlur={() => setRenaming(null)}
                      className={`${input} flex-1 min-w-0`}
                    />
                  ) : (
                    <button
                      onClick={() => (picking && m.enabled ? onChoose(m) : undefined)}
                      disabled={!picking || !m.enabled}
                      className="flex-1 min-w-0 text-left disabled:cursor-default cursor-pointer"
                      title={picking ? `Choose a folder on ${m.label}` : m.target}
                    >
                      <span className="block text-[13px] font-medium text-[var(--color-fg)] truncate">{m.label}</span>
                      <span className="block text-[11px] font-mono text-[var(--color-fg3)] truncate">
                        {m.target}{m.platform ? ` · ${m.platform}` : ""}
                      </span>
                    </button>
                  )}
                  <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-fg2)]">
                    {doing ? <span className="flex items-center gap-1"><Loader2 size={11} className="animate-spin" />{doing}</span> : statusWords(s, m.enabled)}
                  </span>
                  {picking && m.enabled && <ChevronRight size={14} className="shrink-0 text-[var(--color-fg3)]" />}
                  <div className="relative">
                    <button
                      onClick={() => setMenu(menu === m.id ? null : m.id)}
                      className="size-6 grid place-items-center rounded text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] cursor-pointer"
                      aria-label={`${m.label} actions`}
                    ><MoreHorizontal size={14} /></button>
                    {menu === m.id && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setMenu(null)} />
                        <div className="hm-popover absolute right-0 top-7 z-20 w-[180px] flex flex-col text-[12px]">
                          {[
                            ["Check now", () => run(m, "checking", () => window.hive.machineCheck(m.id))],
                            [s.state === "no-hive" ? "Install hive" : "Update hive", () => run(m, "installing", () => window.hive.machineInstall(m.id))],
                            ["Rename", () => { setMenu(null); setRenaming({ id: m.id, draft: m.label }); }],
                            ["Set password…", () => { setMenu(null); setAskPassword(m.id); }],
                            [m.enabled ? "Turn off" : "Turn on", () => run(m, "saving", () => window.hive.machineUpdate(m.id, { enabled: !m.enabled }))],
                            ["Remove", () => run(m, "removing", () => window.hive.machineRemove(m.id))],
                          ].map(([label, fn]) => (
                            <button
                              key={label as string}
                              onClick={fn as () => void}
                              className={`text-left px-2 py-1.5 rounded hover:bg-[var(--color-bg4)] cursor-pointer ${label === "Remove" ? "text-[var(--color-err)]" : "text-[var(--color-fg)]"}`}
                            >{label as string}</button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                </div>
                {askPassword === m.id && (
                  <form
                    className="px-2.5 pb-2.5 flex items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const value = new FormData(e.currentTarget).get("pw");
                      setAskPassword(null);
                      void run(m, "saving", async () => {
                        const saved = await window.hive.machineSetPassword(m.id, String(value ?? ""));
                        setNotes((n) => ({ ...n, [m.id]: saved ? "password saved" : "no OS keychain here — the password lasts until the app closes" }));
                        await window.hive.machineCheck(m.id).catch(() => {});
                      });
                    }}
                  >
                    <input name="pw" type="password" autoFocus data-escape-local="" aria-label={`password for ${m.label}`} placeholder={`password for ${m.target}`} className={input} onKeyDown={(e) => { if (e.key === "Escape") setAskPassword(null); }} />
                    <button type="submit" className={primary}>Save</button>
                  </form>
                )}
                {notes[m.id] && <p className="px-2.5 pb-2 text-[11px] text-[var(--color-fg2)]">{notes[m.id]}</p>}
                {m.enabled && s.state === "attention" && (
                  <div className="px-2.5 pb-2.5">
                    <AttentionNote target={m.target} detail={s.detail} needsPassword={s.needsPassword} onSetPassword={() => setAskPassword(m.id)} />
                  </div>
                )}
                {m.enabled && s.state === "no-hive" && (
                  <div className="mx-2.5 mb-2.5 flex items-center gap-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-line2)] px-2.5 py-1.5 text-[11.5px] text-[var(--color-fg2)]">
                    <span className="min-w-0 flex-1">{s.detail ? `${s.detail}: ` : ""}terminals here stop when the connection drops.</span>
                    <button onClick={() => run(m, "installing", () => window.hive.machineInstall(m.id))} className="text-[var(--color-brand)] hover:underline cursor-pointer shrink-0">Install hive</button>
                  </div>
                )}
                {m.enabled && s.state === "offline" && s.detail && <p className="px-2.5 pb-2 text-[11px] text-[var(--color-fg3)] truncate" title={s.detail}>{s.detail}</p>}
                {errors[m.id] && errors[m.id] !== s.detail && <p className="px-2.5 pb-2 text-[11px] text-[var(--color-err)] break-words">{errors[m.id]}</p>}
              </li>
            );
          })}
        </ul>
      )}
      {snap.machines.length > 0 && (
        <footer className="flex items-center gap-2 px-4 py-2.5 border-t border-[var(--color-line)]">
          <span className="text-[11px] text-[var(--color-fg3)]">Same list as <span className="font-mono">hive machine</span> in a terminal.</span>
          <button onClick={onAdd} className={`ml-auto ${primary}`}><Plus size={13} /> Add</button>
        </footer>
      )}
    </div>
  );
}

function AddMachine({ initialTarget, onCancel, onAdded }: { initialTarget?: string; onCancel: () => void; onAdded: (m: MachineInfo) => void }) {
  const [target, setTarget] = useState(initialTarget ?? "");
  const [label, setLabel] = useState("");
  const [install, setInstall] = useState(true);
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ attention: boolean; text: string } | null>(null);
  const [warn, setWarn] = useState<MachineInfo | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { const t = setTimeout(() => first.current?.focus(), 30); return () => clearTimeout(t); }, []);

  async function add() {
    if (!target.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await window.hive.machineAdd({ target: target.trim(), label: label.trim() || undefined, install, password: usePassword && password ? password : undefined });
      if (r.passwordSaved === false) { setWarn(r.machine); return; }
      onAdded(r.machine);
    } catch (e) {
      const t = errText(e);
      setError({ attention: t.startsWith("[attention]"), text: t.replace(/^\[\w+\] /, "") });
    } finally {
      setBusy(false);
    }
  }

  if (warn) {
    return (
      <div className="p-4 grid gap-3">
        <p className="text-[12.5px] text-[var(--color-fg2)] leading-relaxed">
          <span className="text-[var(--color-fg)]">{warn.label} is saved and connected</span>, but this computer has no OS keychain available,
          so its password is kept only until the app closes. Next time, open Machines and use “Set password…”, or set up an ssh key instead.
        </p>
        <div className="flex justify-end"><button onClick={() => onAdded(warn)} className={primary}>Got it</button></div>
      </div>
    );
  }
  return (
    <form className="p-4 grid gap-3" onSubmit={(e) => { e.preventDefault(); void add(); }}>
      <label className="grid gap-1">
        <span className="u-eyebrow">SSH target</span>
        <input ref={first} value={target} onChange={(e) => setTarget(e.target.value)} placeholder="gpu-box   ·   me@10.0.0.5   ·   ssh://me@host:2222" className={`${input} font-mono`} spellCheck={false} />
        <span className="text-[11px] text-[var(--color-fg3)]">Anything plain <span className="font-mono">ssh</span> accepts, including aliases from <span className="font-mono">~/.ssh/config</span>.</span>
      </label>
      <label className="grid gap-1">
        <span className="u-eyebrow">Name <span className="lowercase tracking-normal text-[var(--color-fg3)]">(optional)</span></span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="the host name" className={input} />
      </label>
      <label className="flex items-center gap-2 text-[12px] text-[var(--color-fg2)] cursor-pointer select-none">
        <input type="checkbox" checked={install} onChange={(e) => setInstall(e.target.checked)} className="accent-[var(--color-brand)]" />
        Install <span className="font-mono">hive</span> there if it is missing, so terminals survive drops
      </label>
      {usePassword ? (
        <label className="grid gap-1">
          <span className="u-eyebrow">Password <span className="lowercase tracking-normal text-[var(--color-fg3)]">(kept in your OS keychain)</span></span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" className={input} />
        </label>
      ) : (
        <button type="button" onClick={() => setUsePassword(true)} className="w-fit text-[11.5px] text-[var(--color-fg3)] hover:text-[var(--color-fg)] cursor-pointer">This host has no key set up — use a password</button>
      )}
      {error && (error.attention
        ? <AttentionNote target={target.trim()} detail={error.text} />
        : <p className="text-[11.5px] text-[var(--color-err)] break-words">{error.text}</p>)}
      <div className="flex items-center justify-end gap-2 pt-1">
        {busy && <span className="mr-auto flex items-center gap-1.5 text-[11.5px] text-[var(--color-fg2)]"><Loader2 size={12} className="animate-spin" />{install ? "Connecting, installing hive if needed…" : "Connecting…"}</span>}
        <button type="button" onClick={onCancel} className={quiet}>Cancel</button>
        <button type="submit" disabled={busy || !target.trim()} className={primary}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Add machine
        </button>
      </div>
    </form>
  );
}

function FolderPicker({ machine, onPick, actionLabel }: { machine: MachineInfo; onPick: (uri: string) => void; actionLabel: string }) {
  const base = useMemo(() => machineUri(machine.target), [machine.target]);
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<RemoteDirEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function list(next: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await window.hive.sshListDir(base, next);
      setDir(r.dir);
      setEntries(r.entries.filter((e) => e.isDir));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { void list(""); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [base]);

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 px-3 h-9 border-b border-[var(--color-line2)] text-[11.5px]">
        <button onClick={() => list(posixJoin(dir, ".."))} disabled={!dir || dir === "/"} className="px-1 text-[var(--color-fg2)] hover:text-[var(--color-fg)] disabled:opacity-30 cursor-pointer">..</button>
        <span className="font-mono text-[var(--color-fg2)] truncate flex-1" title={dir}>{dir || "…"}</span>
        <button onClick={() => list(dir)} aria-label="refresh" className="text-[var(--color-fg3)] hover:text-[var(--color-fg)] cursor-pointer"><RefreshCw size={12} className={busy ? "animate-spin" : ""} /></button>
      </div>
      <div className="h-[280px] overflow-y-auto p-1">
        {error ? (
          <p className="px-3 py-4 text-[11.5px] text-[var(--color-err)] break-words">{error}</p>
        ) : entries.length === 0 ? (
          <div className="px-3 py-8 text-center text-[11.5px] text-[var(--color-fg3)]">{busy ? "Loading…" : "No folders here."}</div>
        ) : (
          entries.map((e) => (
            <button key={e.name} onClick={() => list(posixJoin(dir, e.name))} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-[12px] text-[var(--color-fg2)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)] cursor-pointer">
              <Folder size={14} className="shrink-0 text-[var(--color-fg3)]" />
              <span className="truncate flex-1">{e.name}</span>
              <ChevronRight size={13} className="shrink-0 text-[var(--color-fg3)]" />
            </button>
          ))
        )}
      </div>
      <footer className="flex items-center gap-2 px-3 py-2.5 border-t border-[var(--color-line2)]">
        <span className="flex-1 min-w-0 text-[11px] text-[var(--color-fg3)] font-mono truncate" title={dir}>{machine.label}:{dir}</span>
        <button onClick={() => onPick(machineUri(machine.target, dir))} disabled={!dir || busy} className={`${primary} shrink-0 whitespace-nowrap`}>{actionLabel}</button>
      </footer>
    </div>
  );
}
