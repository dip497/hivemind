/**
 * Share (design §4.2 A): an invite link to this workspace, for a role, that expires. The link is
 * single-use unless made reusable; the person here is asked before anyone joins with it. And
 * where the workspace is hosted (§5.7 B): this computer, until it is moved to one of your hosts,
 * which keeps it open while this computer sleeps.
 */
import { useEffect, useState } from "react";
import type { PairedDeviceSummary } from "../../../shared/ipc";
import type { NetworkProfile } from "@hivemind/workspace-host/network-profile";
import { ReachChooser } from "./reach-chooser";
import { ROLE_LABELS } from "./people";
import { useShown } from "./shown";
import { Check, Copy, Share2, Users } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog";
import { Button } from "../components/ui/button";

type LinkRole = "view" | "edit" | "terminals";

const EXPIRIES: Array<[string, number]> = [["1 hour", 3_600_000], ["24 hours", 86_400_000], ["7 days", 604_800_000]];

export function ShareDialog({ repo, open, onClose, onPeople, onMoved }: { repo: string; open: boolean; onClose: () => void; onPeople: () => void; onMoved: (uri: string) => void }) {
  const [role, setRole] = useState<LinkRole>("view");
  const [expiresIn, setExpiresIn] = useState(86_400_000);
  const [reusable, setReusable] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [net, setNet] = useState<NetworkProfile | null>(null);
  const [reaching, setReaching] = useState(false);
  // A workspace hosted on another of the person's devices: that device makes the link, on its network.
  const elsewhere = repo.startsWith("hive://");
  useEffect(() => { if (open && !elsewhere) void window.hive.network().then(setNet, () => setNet(null)); }, [open, elsewhere]);
  const { shared } = useShown();
  const name = elsewhere ? shared?.names.workspace ?? "this workspace" : repo.split(/[\\/]/).filter(Boolean).pop() ?? repo;

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setLink(await window.hive.share(repo, role, expiresIn, reusable));
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));
    } finally {
      setBusy(false);
    }
  };
  const copy = () => {
    if (!link) return;
    void navigator.clipboard.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { onClose(); setLink(null); setError(null); } }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[460px]" data-share-dialog>
        <DialogTitle className="flex items-center"><Share2 size={15} className="mr-2" /> Invite people to {name}</DialogTitle>
        <DialogDescription>
          {elsewhere ? "Works for people who can reach the device it is hosted on." : net && net.builtin !== "local" ? `Works for people on this network, and through ${net.profile.name}'s servers.` : "Works for people on this network."} You are asked before anyone joins.
        </DialogDescription>
        {!elsewhere && net?.builtin === "local" && (reaching
          ? <ReachChooser current={net} onChosen={(n) => { setNet(n); setReaching(false); setLink(null); }} onCancel={() => { setReaching(false); setError("Stays on this network: the link works only here."); }} />
          : <Button size="sm" variant="ghost" className="justify-self-start" onClick={() => setReaching(true)} data-invite-elsewhere>Invite someone elsewhere…</Button>)}
        <div className="settings-row">
          <label htmlFor="share-role">They can</label>
          <select id="share-role" className="w-40" value={role} onChange={(e) => { setRole(e.target.value as LinkRole); setLink(null); }}>
            <option value="view">{ROLE_LABELS.view}</option>
            <option value="edit">{ROLE_LABELS.edit}</option>
            <option value="terminals">{ROLE_LABELS.terminals}</option>
          </select>
        </div>
        <div className="settings-row">
          <label htmlFor="share-expiry">Link expires in</label>
          <select id="share-expiry" className="w-40" value={expiresIn} onChange={(e) => { setExpiresIn(Number(e.target.value)); setLink(null); }}>
            {EXPIRIES.map(([label, ms]) => <option key={ms} value={ms}>{label}</option>)}
          </select>
        </div>
        <label className="flex items-center gap-2 text-[12px]">
          <input type="checkbox" checked={reusable} onChange={(e) => { setReusable(e.target.checked); setLink(null); }} />
          Anyone with the link can use it, not only the first person
        </label>
        {link ? (
          <div className="flex min-w-0 items-center gap-2">
            <code className="flex-1 min-w-0 truncate rounded bg-[var(--color-bg3)] px-2 py-1.5 font-mono text-[11px]" data-share-link title={link}>{link}</code>
            <Button size="sm" variant="outline" className="shrink-0" onClick={copy}>{copied ? <Check /> : <Copy />} Copy link</Button>
          </div>
        ) : (
          <Button onClick={() => void create()} disabled={busy} data-share-create>{busy ? "Making the link…" : "Make a link"}</Button>
        )}
        {error && <p className="text-[12px] text-[var(--color-err)]" role="alert">{error}</p>}
        <Button variant="ghost" size="sm" className="justify-self-start" onClick={onPeople} data-share-people><Users /> People with access…</Button>
        {!elsewhere && <Hosting repo={repo} onMoved={onMoved} />}
      </DialogContent>
    </Dialog>
  );
}

/** Where this workspace is hosted: here, until it is moved to one of the person's hosts. */
function Hosting({ repo, onMoved }: { repo: string; onMoved: (uri: string) => void }) {
  const [hosts, setHosts] = useState<PairedDeviceSummary[]>([]);
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void window.hive.devices().then((all) => {
      const always = all.filter((d) => d.kind === "host");
      setHosts(always);
      setTo((t) => t || always[0]?.device || "");
    }, () => setHosts([]));
  }, []);
  const move = async () => {
    setBusy(true);
    setError(null);
    try {
      onMoved(await window.hive.moveHosting(repo, to));
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));
      setBusy(false);
    }
  };
  return (
    <section className="flex flex-col gap-2 border-t border-[var(--color-line)] pt-3" data-hosting>
      <p className="text-[12px] text-[var(--color-fg2)]">Hosted on this computer: it goes offline when this computer sleeps.</p>
      {hosts.length === 0 ? (
        <p className="text-[12px] text-[var(--color-fg3)]">Pair a host under Settings → Devices to keep it, and the people in it, going while this computer sleeps.</p>
      ) : (
        <div className="flex items-center gap-2">
          <select aria-label="move to" value={to} onChange={(e) => setTo(e.target.value)} data-move-to className="min-w-0 flex-1">
            {hosts.map((h) => <option key={h.device} value={h.device}>{h.name}</option>)}
          </select>
          <Button size="sm" variant="outline" disabled={!to || busy} onClick={() => void move()} data-move-hosting>
            {busy ? "Moving…" : "Move there"}
          </Button>
        </div>
      )}
      <p className="text-[11.5px] text-[var(--color-fg3)]">The board, notes, people and invite links move; whoever is in it follows. Terminals and agents keep running where they are.</p>
      {error && <p className="text-[12px] text-[var(--color-err)]" role="alert">{error}</p>}
    </section>
  );
}
