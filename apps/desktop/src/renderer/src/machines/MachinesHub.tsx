/**
 * Machines — every saved ssh machine with its live state, adding one, and choosing where a
 * frame runs (machine → folder). The list is the same one `hive machine` edits.
 */
import { MenuItem } from "../components/ui/menu-item";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Folder, History, Loader2, MoreHorizontal, Plus, RefreshCw, Server } from "lucide-react";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import type { MachineInfo, RemoteDirEntry } from "../../../shared/ipc";
import { machineUri, posixJoin } from "../../../shared/remote-uri";
import { errText, machineForRequest, statusOf, useMachines, type MachinesRequest } from "./store";
import { AttentionNote, MachineDot, statusWords } from "./status";

type View = { kind: "list" } | { kind: "add" } | { kind: "edit"; machine: MachineInfo } | { kind: "browse"; machine: MachineInfo };

const CHECK_AFTER_MS = 60_000;
const CHECK_PARALLEL = 4;

/** What a machine is used by on this canvas: frames bound to a folder on it, and their terminals. */
export type MachineUsage = (hostId: string) => { frames: number; terminals: number };

export function MachinesHub({ request, onClose, onPick, onRepoint, usageOf, onEndTerminals }: {
  request: MachinesRequest | null;
  /** A machine's address changed: move the frames that ran on `oldHostId` to `target`. */
  onRepoint: (oldHostId: string, target: string) => void;
  onClose: () => void;
  usageOf: MachineUsage;
  /** Kill the terminals running on a machine and close their tiles. */
  onEndTerminals: (hostId: string) => void;
  /** A folder was chosen — for `request.frameId`, or for a new frame when nothing asked. */
  onPick: (frameId: string | null, uri: string) => void;
}) {
  const snap = useMachines();
  const [view, setView] = useState<View>({ kind: "list" });
  const picking = request?.kind === "pick" ? request : null;

  // Which view this request opens on. Only the request moves it: a machine added or checked
  // mid-flow must not throw the user back to the list.
  useEffect(() => {
    if (!request) return;
    const m = machineForRequest(request, snap.machines);
    setView(m ? { kind: "browse", machine: m } : request.kind === "add" ? { kind: "add" } : { kind: "list" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  // The app checks every machine at startup, so opening this only chases the ones still unknown
  // (added elsewhere since, or saved while the app was closed). A host that needs a login waits for
  // the person: re-probing it only piles up failed logins.
  const refreshed = useRef<MachinesRequest | null>(null);
  useEffect(() => {
    if (!request) { refreshed.current = null; return; }
    if (refreshed.current === request || snap.machines.length === 0) return;
    refreshed.current = request;
    const now = Date.now();
    const due = snap.machines.filter((x) => {
      const s = statusOf(snap, x.hostId);
      return x.enabled && s.state === "idle" && now - s.at > CHECK_AFTER_MS;
    });
    const next = async (): Promise<void> => {
      const x = due.shift();
      if (!x) return;
      await window.hive.machineCheck(x.id).catch(() => {});
      return next();
    };
    for (let i = 0; i < CHECK_PARALLEL; i++) void next();
  }, [request, snap]);

  const title = view.kind === "add" ? "Add a machine" : view.kind === "edit" ? `Edit ${view.machine.label}` : view.kind === "browse" ? view.machine.label : picking ? "Run this frame on…" : "Machines";

  return (
    <Dialog open={!!request} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        padding="none"
        className="sm:max-w-[560px] overflow-hidden grid-cols-[minmax(0,1fr)]"
        // Escape in an inline field cancels that field, not the dialog.
        onEscapeKeyDown={(e) => { if ((e.target as HTMLElement | null)?.dataset?.escapeLocal !== undefined) e.preventDefault(); }}
      >
        <header className="flex items-center gap-1.5 pl-4 pr-14 pt-4 pb-2">
          {view.kind !== "list" && !(picking?.machineId && view.kind === "browse") && (
            <Button variant="ghost" size="icon-sm" onClick={() => setView({ kind: "list" })} aria-label="back" className="-ml-1"><ArrowLeft /></Button>
          )}
          <DialogTitle className="h-7 flex items-center">{title}</DialogTitle>
        </header>
        {view.kind === "list" && (
          <MachineList
            usageOf={usageOf}
            onEndTerminals={onEndTerminals}
            picking={!!picking}
            onChoose={(m) => setView({ kind: "browse", machine: m })}
            onEdit={(m) => setView({ kind: "edit", machine: m })}
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
        {view.kind === "edit" && (
          <AddMachine
            editing={view.machine}
            onCancel={() => setView({ kind: "list" })}
            onAdded={() => setView({ kind: "list" })}
            onRepoint={onRepoint}
          />
        )}
        {view.kind === "browse" && (
          <FolderPicker
            machine={view.machine}
            onPick={(uri) => { onPick(picking?.frameId ?? null, uri); onClose(); }}
            actionLabel="Open here"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function MachineList({ picking, onChoose, onEdit, onAdd, usageOf, onEndTerminals }: {
  picking: boolean; onChoose: (m: MachineInfo) => void; onEdit: (m: MachineInfo) => void; onAdd: () => void;
  usageOf: MachineUsage; onEndTerminals: (hostId: string) => void;
}) {
  const snap = useMachines();
  // Remove asks first, and says what it touches: one click used to drop a machine its terminals
  // were running on. Ending those terminals is an opt-in.
  const [removing, setRemoving] = useState<{ id: string; end: boolean } | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
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
          <Button onClick={onAdd}><Plus /> Add a machine</Button>
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
                  <button
                    onClick={() => (m.enabled ? onChoose(m) : undefined)}
                    disabled={!m.enabled}
                    className="flex-1 min-w-0 text-left disabled:cursor-default cursor-pointer"
                    title={m.enabled ? `Open a folder on ${m.label}` : m.target}
                  >
                    <span className="block text-[13px] font-medium text-[var(--color-fg)] truncate">{m.label}</span>
                    <span className="block text-[11px] font-mono text-[var(--color-fg3)] truncate">
                      {m.target}{m.platform ? ` · ${m.platform}` : ""}
                    </span>
                  </button>
                  <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-fg2)]">
                    {doing ? <span className="flex items-center gap-1"><Loader2 size={11} className="animate-spin" />{doing}</span> : statusWords(s, m.enabled)}
                  </span>
                  {m.enabled && <ChevronRight size={14} className="shrink-0 text-[var(--color-fg3)]" />}
                  <div className="relative">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => setMenu(menu === m.id ? null : m.id)}
                      aria-label={`${m.label} actions`}
                    ><MoreHorizontal /></Button>
                    {menu === m.id && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setMenu(null)} />
                        <div className="hm-popover absolute right-0 top-7 z-20 w-[180px] flex flex-col text-[12px]">
                          {[
                            ["Check now", () => run(m, "checking", () => window.hive.machineCheck(m.id))],
                            [s.state === "no-hive" ? "Install hive" : "Update hive", () => run(m, "installing", () => window.hive.machineInstall(m.id))],
                            ["Edit…", () => { setMenu(null); onEdit(m); }],
                            ["Set password…", () => { setMenu(null); setAskPassword(m.id); }],
                            [m.enabled ? "Turn off" : "Turn on", () => run(m, "saving", () => window.hive.machineUpdate(m.id, { enabled: !m.enabled }))],
                            ["Remove…", () => { setMenu(null); setRemoving({ id: m.id, end: false }); }],
                          ].map(([label, fn]) => (
                            <MenuItem
                              key={label as string}
                              onClick={fn as () => void}
                              variant={label === "Remove…" ? "destructive" : "default"}
                            >{label as string}</MenuItem>
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
                    <Input name="pw" type="password" autoFocus data-escape-local="" aria-label={`password for ${m.label}`} placeholder={`password for ${m.target}`} className="h-7" onKeyDown={(e) => { if (e.key === "Escape") setAskPassword(null); }} />
                    <Button type="submit" size="sm">Save</Button>
                  </form>
                )}
                {removing?.id === m.id && (() => {
                  const u = usageOf(m.hostId);
                  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
                  return (
                    <div role="alertdialog" aria-label={`remove ${m.label}`} data-remove-machine={m.id}
                      className="mx-2.5 mb-2.5 grid gap-2 rounded-lg border border-[var(--color-line2)] bg-[var(--color-bg)] px-3 py-2.5 text-[12px] text-[var(--color-fg)]"
                      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setRemoving(null); } }}>
                      <p>
                        Remove <span className="font-semibold">{m.label}</span>?{" "}
                        {u.frames > 0
                          ? <span data-usage>Used by {plural(u.frames, "frame")} · {plural(u.terminals, "terminal")}.</span>
                          : <span data-usage>Nothing on this canvas uses it.</span>}
                      </p>
                      {u.frames > 0 && (
                        <p className="text-[11.5px] text-[var(--color-fg2)]">
                          Its frames keep their tiles{u.terminals > 0 && !removing.end ? " and its terminals keep running" : ""}. Add it again to connect them.
                        </p>
                      )}
                      {u.terminals > 0 && (
                        <label className="flex items-center gap-2 text-[11.5px] text-[var(--color-fg2)] cursor-pointer">
                          <input type="checkbox" checked={removing.end} onChange={(e) => setRemoving({ id: m.id, end: e.target.checked })} />
                          Also end its {plural(u.terminals, "terminal")} on {m.label}
                        </label>
                      )}
                      <div className="flex justify-end gap-2">
                        <Button autoFocus variant="ghost" size="sm" onClick={() => setRemoving(null)}>Cancel</Button>
                        <Button variant="destructive" size="sm" onClick={() => {
                          const end = removing.end;
                          setRemoving(null);
                          if (end) onEndTerminals(m.hostId);
                          void run(m, "removing", () => window.hive.machineRemove(m.id));
                        }}>Remove</Button>
                      </div>
                    </div>
                  );
                })()}
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
          <Button size="sm" onClick={onAdd} className="ml-auto"><Plus /> Add</Button>
        </footer>
      )}
    </div>
  );
}

function AddMachine({ initialTarget, editing, onCancel, onAdded, onRepoint }: {
  initialTarget?: string;
  /** Edit this machine instead of adding one. */
  editing?: MachineInfo;
  onCancel: () => void;
  onAdded: (m: MachineInfo) => void;
  onRepoint?: (oldHostId: string, target: string) => void;
}) {
  const [target, setTarget] = useState(editing?.target ?? initialTarget ?? "");
  const [label, setLabel] = useState(editing?.label ?? "");
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
      if (editing) {
        const r = await window.hive.machineEdit(editing.id, { target: target.trim(), label: label.trim() || undefined, password: usePassword && password ? password : undefined });
        if (r.machine.hostId !== r.oldHostId) onRepoint?.(r.oldHostId, r.machine.target);
        onAdded(r.machine);
        return;
      }
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
        <div className="flex justify-end"><Button onClick={() => onAdded(warn)}>Got it</Button></div>
      </div>
    );
  }
  return (
    <form className="px-4 pb-4 pt-2 grid gap-4" onSubmit={(e) => { e.preventDefault(); void add(); }}>
      <div className="grid gap-2">
        <Label htmlFor="machine-target">Host</Label>
        <Input id="machine-target" ref={first} value={target} onChange={(e) => setTarget(e.target.value)} placeholder="user@host or ~/.ssh/config alias" font="mono" spellCheck={false} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="machine-label">Name</Label>
        <Input id="machine-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={target.trim() || "Optional"} />
      </div>
      {usePassword ? (
        <div className="grid gap-2">
          <Label htmlFor="machine-password">Password</Label>
          <Input id="machine-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
          <p className="text-[11px] text-muted-foreground">Stored in your OS keychain.</p>
        </div>
      ) : (
        <Button type="button" variant="link" size="xs" onClick={() => setUsePassword(true)} className="-mt-2 justify-self-start ">Use a password instead</Button>
      )}
      {editing && <p className="-mt-1 text-[11px] text-muted-foreground">A new address is reached before it is saved. Frames on {editing.label} move with it; terminals already open keep their session.</p>}
      {!editing && <div className="flex items-center justify-between gap-4">
        <Label htmlFor="machine-install" className="cursor-pointer">Install <span className="font-mono">hive</span> if missing</Label>
        <Switch id="machine-install" checked={install} onCheckedChange={setInstall} />
      </div>}
      {error && (error.attention
        ? <AttentionNote target={target.trim()} detail={error.text} />
        : <p className="text-[11.5px] text-destructive break-words">{error.text}</p>)}
      <div className="flex items-center justify-end gap-2">
        {busy && <span className="mr-auto flex items-center gap-1.5 text-[11.5px] text-muted-foreground"><Loader2 size={12} className="animate-spin" />Connecting…</span>}
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={busy || !target.trim()}>{editing ? "Save" : "Add"}</Button>
      </div>
    </form>
  );
}

const RECENT_MAX = 5;
const recentKey = (m: MachineInfo) => `hivemind:machine-recent:${m.id}`;
function readRecent(m: MachineInfo): string[] {
  try { const v = JSON.parse(localStorage.getItem(recentKey(m)) ?? "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, RECENT_MAX) : []; } catch { return []; }
}
function pushRecent(m: MachineInfo, dir: string): void {
  try { localStorage.setItem(recentKey(m), JSON.stringify([dir, ...readRecent(m).filter((d) => d !== dir)].slice(0, RECENT_MAX))); } catch { /* private mode */ }
}
const parentOf = (d: string) => (d === "/" ? "/" : d.replace(/\/[^/]+\/?$/, "") || "/");

function FolderPicker({ machine, onPick, actionLabel }: { machine: MachineInfo; onPick: (uri: string) => void; actionLabel: string }) {
  const base = useMemo(() => machineUri(machine.target), [machine.target]);
  const [dir, setDir] = useState("");
  const [home, setHome] = useState("");
  const [entries, setEntries] = useState<RemoteDirEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const recent = useMemo(() => readRecent(machine), [machine]);
  const seq = useRef(0);
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  async function list(next: string) {
    const mine = ++seq.current;
    setBusy(true);
    setError(null);
    try {
      const r = await window.hive.sshListDir(base, next);
      if (mine !== seq.current) return; // a later click already moved on
      setDir(r.dir);
      if (!next) setHome(r.dir);
      setEntries(r.entries.filter((e) => e.isDir));
      setFilter("");
      setCursor(0);
    } catch (e) {
      if (mine === seq.current) setError(errText(e));
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }
  useEffect(() => { void list(""); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [base]);

  const open = (d: string) => { pushRecent(machine, d); onPick(machineUri(machine.target, d)); };
  const expand = (p: string) => (p === "~" ? home : p.startsWith("~/") && home ? posixJoin(home, p.slice(2)) : p);
  const q = filter.trim().toLowerCase();
  const shown = entries.filter((e) => (q.startsWith(".") || !e.name.startsWith(".")) && (!q || e.name.toLowerCase().includes(q)));
  const showRecent = !q && dir === home && recent.length > 0;
  const crumbs = dir.split("/").filter(Boolean);
  useEffect(() => { listRef.current?.querySelector(`[data-row="${cursor}"]`)?.scrollIntoView({ block: "nearest" }); }, [cursor]);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const row = shown[cursor];
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (dir) open(dir); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(shown.length - 1, c + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    else if ((e.key === "Enter" || (e.key === "ArrowRight" && e.currentTarget.selectionStart === filter.length)) && row) { e.preventDefault(); void list(posixJoin(dir, row.name)); }
    else if ((e.key === "ArrowLeft" && !filter) || (e.key === "Backspace" && !filter)) { e.preventDefault(); if (dir !== "/") void list(parentOf(dir)); }
    else if (e.key === "Escape" && filter) { e.preventDefault(); e.stopPropagation(); setFilter(""); }
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 px-2 h-9 border-b border-[var(--color-line2)] text-[11.5px]">
        <Button variant="ghost" size="icon-2xs" onClick={() => list(parentOf(dir))} disabled={!dir || dir === "/"} aria-label="up" title="Up (←)"><ArrowLeft /></Button>
        {editingPath !== null ? (
          <Input
            autoFocus
            data-escape-local=""
            aria-label="path"
            value={editingPath}
            onChange={(e) => setEditingPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); const p = expand(editingPath.trim()); setEditingPath(null); if (p) void list(p); filterRef.current?.focus(); }
              if (e.key === "Escape") { e.preventDefault(); setEditingPath(null); filterRef.current?.focus(); }
            }}
            onBlur={() => setEditingPath(null)}
            font="mono"
            spellCheck={false}
            className="h-7 flex-1"
          />
        ) : (
          <div className="flex-1 min-w-0 flex items-center overflow-x-auto font-mono text-[var(--color-fg2)]" onDoubleClick={() => setEditingPath(dir)}>
            <button onClick={() => list("/")} className="px-1 rounded hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)] cursor-pointer">/</button>
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center shrink-0">
                {i > 0 && <span className="text-[var(--color-fg3)]">/</span>}
                <button
                  onClick={() => list("/" + crumbs.slice(0, i + 1).join("/"))}
                  className={`px-1 rounded hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)] cursor-pointer ${i === crumbs.length - 1 ? "text-[var(--color-fg)]" : ""}`}
                >{c}</button>
              </span>
            ))}
          </div>
        )}
        <Button variant="ghost" size="2xs" onClick={() => setEditingPath(dir)} title="Type a path (~ works)">Go to…</Button>
        <Button variant="ghost" size="icon-2xs" onClick={() => list(dir)} aria-label="refresh"><RefreshCw className={busy ? "animate-spin" : ""} /></Button>
      </div>
      <div className="px-2 pt-2">
        <Input
          ref={filterRef}
          autoFocus
          {...(filter ? { "data-escape-local": "" } : {})}
          aria-label="filter folders"
          placeholder="Filter · ↑↓ move · Enter go in · ← up · Ctrl+Enter open"
          value={filter}
          onChange={(e) => { setFilter(e.target.value); setCursor(0); }}
          onKeyDown={onKey}
          className="h-8"
        />
      </div>
      <div ref={listRef} className="h-[300px] overflow-y-auto p-1.5" role="listbox" aria-label="folders">
        {showRecent && (
          <div className="mb-1.5 pb-1.5 border-b border-[var(--color-line)]">
            <div className="px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[var(--color-fg3)]">Recent</div>
            {recent.map((d) => (
              <button key={d} onClick={() => open(d)} title={`Open ${d}`} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-[12px] text-[var(--color-fg2)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)] cursor-pointer">
                <History size={13} className="shrink-0 text-[var(--color-fg3)]" />
                <span className="truncate flex-1 font-mono">{home && d.startsWith(home + "/") ? "~" + d.slice(home.length) : d}</span>
              </button>
            ))}
          </div>
        )}
        {error ? (
          <p className="px-3 py-4 text-[11.5px] text-[var(--color-err)] break-words">{error}</p>
        ) : shown.length === 0 ? (
          <div className="px-3 py-8 text-center text-[11.5px] text-[var(--color-fg3)]">{busy ? "Loading…" : q ? `No folder matches “${filter}”.` : "No folders here — open this one, or go up."}</div>
        ) : (
          shown.map((e, i) => (
            <div
              key={e.name}
              data-row={i}
              role="option"
              aria-selected={i === cursor}
              onMouseEnter={() => setCursor(i)}
              onClick={() => list(posixJoin(dir, e.name))}
              onDoubleClick={() => open(posixJoin(dir, e.name))}
              className={`group/row flex items-center gap-2 px-2 h-8 rounded-md text-[12.5px] cursor-pointer ${i === cursor ? "bg-[var(--color-bg3)] text-[var(--color-fg)]" : "text-[var(--color-fg2)]"}`}
            >
              <Folder size={14} className="shrink-0 text-[var(--color-fg3)]" />
              <span className="truncate flex-1">{e.name}</span>
              <Button
                variant="ghost"
                size="2xs"
                className={i === cursor ? "" : "invisible group-hover/row:visible"}
                onClick={(ev) => { ev.stopPropagation(); open(posixJoin(dir, e.name)); }}
              >Open</Button>
              <ChevronRight size={13} className="shrink-0 text-[var(--color-fg3)]" />
            </div>
          ))
        )}
      </div>
      <footer className="flex items-center gap-2 px-3 py-2.5 border-t border-[var(--color-line2)]">
        <span className="flex-1 min-w-0 text-[11px] text-[var(--color-fg3)] font-mono truncate" title={dir}>{machine.label}:{dir}</span>
        <Button onClick={() => open(dir)} disabled={!dir || busy} size="sm">{actionLabel}</Button>
      </footer>
    </div>
  );
}
