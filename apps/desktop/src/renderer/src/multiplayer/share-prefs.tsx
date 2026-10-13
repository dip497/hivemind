/**
 * Settings → People (design §4.2 A), for the workspace this window shows: who has access, shown;
 * then an invite link, its choices first (a role, an expiry, one person or anyone) and the link,
 * with its QR code, made from them. The person here is asked before anyone joins with it. And where
 * the workspace runs (§5.7 B): this computer, until it is moved to one of your hosts, which keeps it
 * open while this computer sleeps.
 */
import { useEffect, useState } from "react";
import type { PairedDeviceSummary } from "../../../shared/ipc";
import type { NetworkProfile } from "@hivemind/workspace-host/network-profile";
import { ReachChooser } from "./reach-chooser";
import { PeopleList } from "./people-list";
import { ROLE_LABELS } from "./people";
import { useShown } from "./shown";
import { useCanShare } from "./workspace-actions";
import { Check, ChevronDown, Copy } from "../components/icons";
import { Button } from "../components/ui/button";
import { QrCode } from "../components/qr-code";
import { useSettingsNavigate } from "../settings-panels";

type LinkRole = "view" | "edit" | "terminals";

const EXPIRIES: Array<[string, number]> = [["1 hour", 3_600_000], ["24 hours", 86_400_000], ["7 days", 604_800_000]];

/** A move is answered outside Settings, which closes for it (App). */
const openMoved = (uri: string) => window.dispatchEvent(new CustomEvent("hivemind:open-moved", { detail: { uri } }));

export function PeoplePrefs() {
  const { repo } = useShown();
  const owner = useCanShare();
  if (!repo) return <p className="settings-note">Open a workspace to share it.</p>;
  if (!owner) return <p className="settings-note" data-share-not-owner>This workspace is its owner's to share.</p>;
  return <Share key={repo} repo={repo} />;
}

function Share({ repo }: { repo: string }) {
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
  useEffect(() => { if (!elsewhere) void window.hive.network().then(setNet, () => setNet(null)); }, [elsewhere]);
  const { shared } = useShown();
  const name = elsewhere ? shared?.names.workspace ?? "this workspace" : repo.split(/[\\/]/).filter(Boolean).pop() ?? repo;

  // One press makes the link and copies it: what someone sharing wants next is to paste it.
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await window.hive.share(repo, role, expiresIn, reusable);
      setLink(made);
      await writeClipboard(made);
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));
    } finally {
      setBusy(false);
    }
  };
  const writeClipboard = (text: string) => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
  const copy = () => { if (link) void writeClipboard(link); };

  const works = elsewhere ? "Works for people who can reach the device it is hosted on."
    : net && net.builtin !== "local" ? `Works for people on this network, and through ${net.profile.name}'s servers.` : "Works for people on this network.";
  const field = "flex min-w-[140px] flex-1 flex-col gap-1 text-[12px] text-[var(--color-fg2)]";

  return (
    <div className="flex flex-col gap-6" data-share-page>
      <section aria-label="Who has access" className="flex flex-col gap-1" data-share-access>
        <h3 className="text-[13px] font-semibold">Who has access</h3>
        <PeopleList repo={repo} />
      </section>

      <section aria-label="Invite link" className="flex flex-col gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg2)] p-4" data-share-invite>
        <div className="flex flex-col gap-0.5">
          <h3 className="text-[13px] font-semibold">Invite people to {name}</h3>
          <p className="text-[12px] text-[var(--color-fg3)]">{works} You are asked before anyone joins.</p>
        </div>
        <div className="flex flex-wrap gap-3" data-share-choices>
          <label className={field}>They can
            <select id="share-role" value={role} onChange={(e) => { setRole(e.target.value as LinkRole); setLink(null); }}>
              <option value="view">{ROLE_LABELS.view}</option>
              <option value="edit">{ROLE_LABELS.edit}</option>
              <option value="terminals">{ROLE_LABELS.terminals}</option>
            </select>
          </label>
          <label className={field}>Expires in
            <select id="share-expiry" value={expiresIn} onChange={(e) => { setExpiresIn(Number(e.target.value)); setLink(null); }}>
              {EXPIRIES.map(([label, ms]) => <option key={ms} value={ms}>{label}</option>)}
            </select>
          </label>
          <label className={field}>Who can use it
            <select id="share-reusable" value={reusable ? "anyone" : "first"} onChange={(e) => { setReusable(e.target.value === "anyone"); setLink(null); }}>
              <option value="first">Only the first person</option>
              <option value="anyone">Anyone with the link</option>
            </select>
          </label>
        </div>
        {link ? (
          <div className="flex flex-wrap items-start gap-4">
            <QrCode text={link} label="QR code of the invite link" data-share-qr />
            <div className="flex min-w-[200px] flex-1 flex-col gap-2">
              <code className="truncate rounded bg-[var(--color-bg3)] px-2 py-1.5 font-mono text-[11px]" data-share-link title={link}>{link}</code>
              <div><Button size="sm" variant="outline" onClick={copy} data-share-copy>{copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy again"}</Button></div>
              <p className="text-[12px] text-[var(--color-fg3)]">Someone next to you can scan the code; press it to show it larger.</p>
            </div>
          </div>
        ) : (
          <Button className="self-start" onClick={() => void create()} disabled={busy} data-share-create><Copy />{busy ? "Making the link…" : "Copy invite link"}</Button>
        )}
        {!elsewhere && net?.builtin === "local" && (reaching
          ? <ReachChooser current={net} onChosen={(n) => { setNet(n); setReaching(false); setLink(null); }} onCancel={() => { setReaching(false); setError("Stays on this network: the link works only here."); }} />
          : <Button size="sm" variant="ghost" className="self-start" onClick={() => setReaching(true)} data-invite-elsewhere>Invite someone elsewhere…</Button>)}
        {error && <p className="text-[12px] text-[var(--color-err)]" role="alert">{error}</p>}
      </section>

      {!elsewhere && <Hosting repo={repo} onMoved={openMoved} />}
    </div>
  );
}

/** Where this workspace is hosted: here, until it is moved to one of the person's hosts. */
function Hosting({ repo, onMoved }: { repo: string; onMoved: (uri: string) => void }) {
  const go = useSettingsNavigate();
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
    <section aria-label="Where it runs" className="flex flex-col gap-2" data-hosting>
      <h3 className="text-[13px] font-semibold">Where it runs</h3>
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-[200px] flex-1 text-[12px] text-[var(--color-fg2)]" data-hosting-status>Runs on this computer; offline while it sleeps.</p>
        {hosts.length === 0 ? (
          <Button size="sm" variant="outline" onClick={() => go("your-devices")} data-keep-running>Keep it running</Button>
        ) : (
          <>
            <select aria-label="Move to" value={to} onChange={(e) => setTo(e.target.value)} data-move-to>
              {hosts.map((h) => <option key={h.device} value={h.device}>{h.name}</option>)}
            </select>
            <Button size="sm" variant="outline" disabled={!to || busy} onClick={() => void move()} data-move-hosting>
              {busy ? "Moving…" : "Move there"}
            </Button>
          </>
        )}
      </div>
      {error && <p className="text-[12px] text-[var(--color-err)]" role="alert">{error}</p>}
      <details className="settings-disclosure" data-hosting-how>
        <summary>How hosting works <ChevronDown size={14} /></summary>
        <div className="flex flex-col gap-1.5 pb-3 text-[12px] text-[var(--color-fg3)]">
          <p>A host (<code className="font-mono">hive host</code> on a server, paired under Your devices → Another computer) keeps this workspace, and the people in it, going while this computer sleeps.</p>
          <p>Moving it there takes the board, notes, people and invite links; whoever is in it follows. Terminals and agents keep running where they are.</p>
        </div>
      </details>
    </section>
  );
}
