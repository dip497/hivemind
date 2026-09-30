/**
 * Share (design §4.2 A): an invite link to this workspace, for a role, that expires. The link is
 * single-use unless made reusable; the person here is asked before anyone joins with it.
 */
import { useEffect, useState } from "react";
import type { NetworkProfile } from "@hivemind/workspace-host/network-profile";
import { ReachChooser } from "./reach-chooser";
import { ROLE_LABELS } from "./people";
import { Check, Copy, Share2, Users } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog";
import { Button } from "../components/ui/button";

type LinkRole = "view" | "edit" | "terminals";

const EXPIRIES: Array<[string, number]> = [["1 hour", 3_600_000], ["24 hours", 86_400_000], ["7 days", 604_800_000]];

export function ShareDialog({ repo, open, onClose, onPeople }: { repo: string; open: boolean; onClose: () => void; onPeople: () => void }) {
  const [role, setRole] = useState<LinkRole>("view");
  const [expiresIn, setExpiresIn] = useState(86_400_000);
  const [reusable, setReusable] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [net, setNet] = useState<NetworkProfile | null>(null);
  const [reaching, setReaching] = useState(false);
  useEffect(() => { if (open) void window.hive.network().then(setNet, () => setNet(null)); }, [open]);
  const name = repo.split(/[\\/]/).filter(Boolean).pop() ?? repo;

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
      <DialogContent className="sm:max-w-[460px]" data-share-dialog>
        <DialogTitle className="flex items-center gap-2"><Share2 size={15} /> Invite people to {name}</DialogTitle>
        <DialogDescription>
          {net && net.builtin !== "local" ? `Works for people on this network, and through ${net.profile.name}'s servers.` : "Works for people on this network."} You are asked before anyone joins.
        </DialogDescription>
        {net?.builtin === "local" && (reaching
          ? <ReachChooser current={net} onChosen={(n) => { setNet(n); setReaching(false); setLink(null); }} onCancel={() => { setReaching(false); setError("Stays on this network: the link works only here."); }} />
          : <Button size="sm" variant="ghost" className="self-start" onClick={() => setReaching(true)} data-invite-elsewhere>Invite someone elsewhere…</Button>)}
        <div className="settings-row">
          <label htmlFor="share-role">They can</label>
          <select id="share-role" value={role} onChange={(e) => { setRole(e.target.value as LinkRole); setLink(null); }}>
            <option value="view">{ROLE_LABELS.view}</option>
            <option value="edit">{ROLE_LABELS.edit}</option>
            <option value="terminals">{ROLE_LABELS.terminals}</option>
          </select>
        </div>
        <div className="settings-row">
          <label htmlFor="share-expiry">Link expires in</label>
          <select id="share-expiry" value={expiresIn} onChange={(e) => { setExpiresIn(Number(e.target.value)); setLink(null); }}>
            {EXPIRIES.map(([label, ms]) => <option key={ms} value={ms}>{label}</option>)}
          </select>
        </div>
        <label className="flex items-center gap-2 text-[12px]">
          <input type="checkbox" checked={reusable} onChange={(e) => { setReusable(e.target.checked); setLink(null); }} />
          Anyone with the link can use it, not only the first person
        </label>
        {link ? (
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate rounded bg-[var(--color-bg3)] px-2 py-1.5 font-mono text-[11px]" data-share-link title={link}>{link}</code>
            <Button size="sm" variant="outline" onClick={copy}>{copied ? <Check /> : <Copy />} Copy link</Button>
          </div>
        ) : (
          <Button onClick={() => void create()} disabled={busy} data-share-create>{busy ? "Making the link…" : "Make a link"}</Button>
        )}
        {error && <p className="text-[12px] text-[var(--color-err)]" role="alert">{error}</p>}
        <Button variant="ghost" size="sm" className="self-start" onClick={onPeople} data-share-people><Users /> People with access…</Button>
      </DialogContent>
    </Dialog>
  );
}
