/**
 * Settings → Network (R16, design §13.2–13.3): which network this computer is on (the local
 * network, with no servers, by default; hivemind's servers; or one someone runs, from its network
 * link), who signed it, whether its servers answer, and the update check, the one thing the app
 * reaches outside it.
 */
import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import type { NetworkHealth, NetworkProfile } from "@hivemind/workspace-host/network-profile";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Switch } from "./components/ui/switch";
import { Section } from "./appearance-controls";
import { patchSettings, useSettings } from "./settings-store";

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** What the network is, in a sentence. */
function about(net: NetworkProfile): string {
  if (net.builtin === "local") return "Devices find each other on this network. Nothing leaves it. Devices outside it can't connect.";
  if (net.builtin === "hosted") return "hivemind's servers forward encrypted traffic and help devices find each other. They never see your work.";
  return `Run by its admin, who signed it (${net.admin?.slice(0, 8)}…). Only its servers are used.`;
}

export function NetworkPrefs() {
  const { network: settings } = useSettings();
  // undefined while it is asked for; null where no app answers, or hive-net is not installed.
  const [net, setNet] = useState<NetworkProfile | null | undefined>(undefined);
  const [health, setHealth] = useState<NetworkHealth | null>(null);
  const [checking, setChecking] = useState(false);
  const [changing, setChanging] = useState(false);
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void window.hive.network().then((n) => setNet(n ?? null), (e: unknown) => { setNet(null); setError(messageOf(e)); }); }, []);

  const check = async () => {
    setChecking(true);
    setError(null);
    try { setHealth(await window.hive.networkHealth()); } catch (e) { setError(messageOf(e)); } finally { setChecking(false); }
  };
  const use = async (given: string) => {
    setError(null);
    try {
      setNet(await window.hive.useNetwork(given));
      setHealth(null);
      setChanging(false);
      setLink("");
    } catch (e) {
      setError(messageOf(e));
    }
  };
  const ok = (url: string) => health?.relays.find((r) => r.url.replace(/\/$/, "") === url.replace(/\/$/, ""))?.ok;

  return (
    <div className="settings-stack">
      <Section title="This computer's network" hint="Where it finds and reaches other devices">
        {net === undefined ? null : net === null ? (
          <p className="settings-note">{error ?? "Only the app knows"}</p>
        ) : (
          <div className="flex flex-col gap-3" data-network={net.builtin ?? "signed"}>
            <div>
              <div className="text-[14px] font-medium" data-network-name>{net.profile.name}</div>
              <p className="text-[12px] text-[var(--color-fg3)]">{about(net)}</p>
            </div>
            {net.profile.relays.length > 0 && (
              <ul className="flex flex-col gap-1 text-[12px]" data-network-relays>
                {net.profile.relays.map((r) => (
                  <li key={r.url} className="flex items-center gap-2" data-relay={r.url} data-ok={String(ok(r.url) ?? "")}>
                    {ok(r.url) === true ? <Check size={13} className="text-[var(--color-ok)]" /> : ok(r.url) === false ? <X size={13} className="text-[var(--color-err)]" /> : <span className="w-[13px]" />}
                    <span className="text-[var(--color-fg3)]">Relay</span>
                    <code className="truncate font-mono text-[11px]">{r.url}</code>
                  </li>
                ))}
                {net.profile.access && <li className="pl-[21px] text-[var(--color-fg3)]">Who may use them: {net.profile.access.policy === "closed" ? "devices its admin lets in" : "any device that registers"}</li>}
              </ul>
            )}
            <div className="flex gap-2">
              {net.profile.relays.length > 0 && <Button size="sm" variant="outline" onClick={() => void check()} disabled={checking} data-network-check>{checking ? "Checking…" : "Check"}</Button>}
              <Button size="sm" variant="outline" onClick={() => setChanging((c) => !c)} data-network-change>Change…</Button>
            </div>
            {changing && (
              <div className="flex flex-col gap-2 rounded-md border border-[var(--color-line)] p-3" data-network-chooser>
                <Button size="sm" variant="ghost" className="justify-start" disabled={net.builtin === "local"} onClick={() => void use("local")} data-use-network="local">
                  Local network — no servers
                </Button>
                <Button size="sm" variant="ghost" className="justify-start" disabled={net.builtin === "hosted"} onClick={() => void use("hosted")} data-use-network="hosted">
                  hivemind's servers
                </Button>
                <div className="flex gap-2">
                  <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="hivemind://network/… from your network's admin" className="flex-1" data-network-link />
                  <Button size="sm" onClick={() => void use(link)} disabled={!link.trim()} data-use-network="link">Use</Button>
                </div>
              </div>
            )}
          </div>
        )}
        {net && error && <p className="text-[12px] text-[var(--color-err)]" role="alert">{error}</p>}
      </Section>
      <Section title="Updates" hint="The one thing the app asks outside its network">
        <div className="settings-row">
          <div>
            <label htmlFor="update-check">Check for new versions</label>
            <p>Asks GitHub now and then. Off, the app reaches nothing its network does not name.</p>
          </div>
          <Switch id="update-check" checked={settings.updateCheck} onCheckedChange={(v) => patchSettings("network.updateCheck", v)} aria-label="Check for new versions" data-update-check />
        </div>
      </Section>
    </div>
  );
}
