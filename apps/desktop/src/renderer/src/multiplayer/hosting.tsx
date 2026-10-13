/**
 * Where a workspace hosted here runs (design §5.7 B), as one line: this computer, until it is moved
 * to one of the person's hosts, which keeps it open while this computer sleeps. Without a host, Keep
 * it running says how to get one.
 */
import { useEffect, useState } from "react";
import type { PairedDeviceSummary } from "../../../shared/ipc";
import { Button } from "../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";

/** A move is answered outside Settings, which closes for it (App). */
const openMoved = (uri: string) => window.dispatchEvent(new CustomEvent("hivemind:open-moved", { detail: { uri } }));
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

export function Hosting({ repo }: { repo: string }) {
  const [hosts, setHosts] = useState<PairedDeviceSummary[]>([]);
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [how, setHow] = useState(false);
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
      openMoved(await window.hive.moveHosting(repo, to));
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 pt-2" aria-label="Where it runs" data-hosting>
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-[200px] flex-1 text-label text-[var(--color-fg2)]" data-hosting-status>Runs on this computer; offline while it sleeps.</p>
        {hosts.length === 0 ? (
          <Button variant="outline" onClick={() => setHow((h) => !h)} aria-expanded={how} data-keep-running>Keep it running</Button>
        ) : (
          <>
            <Select value={to} onValueChange={setTo}>
              <SelectTrigger aria-label="Move to" className="min-w-40" data-move-to><SelectValue /></SelectTrigger>
              <SelectContent>
                {hosts.map((h) => <SelectItem key={h.device} value={h.device}>{h.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="outline" disabled={!to || busy} onClick={() => void move()} data-move-hosting>
              {busy ? "Moving…" : "Move there"}
            </Button>
          </>
        )}
      </div>
      {how && (
        <p className="text-label text-[var(--color-fg3)]" data-hosting-how>
          Run <code className="font-mono">hive host pair</code> on a server and enter the words it shows under Join. That host then keeps this
          workspace, and the people in it, going while this computer sleeps; moving it there takes the board, notes, people and invite links.
        </p>
      )}
      {error && <p className="text-label text-[var(--color-err)]" role="alert">{error}</p>}
    </div>
  );
}
