/**
 * Settings → Servers (R16, design §13.2–13.3): the relay and discovery servers this computer uses
 * to reach the person's other devices: none, on the local network, by default, or a network
 * someone runs, from its network link; who signed it, and whether its servers answer.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, X } from "./components/icons";
import type { NetworkHealth, NetworkProfile } from "@hivemind/workspace-host/network-profile";
import { Button } from "./components/ui/button";
import { Section } from "./appearance-controls";
import { ReachChooser, SET_UP_SERVER } from "./multiplayer/reach-chooser";
import { StartAgentWith } from "./agent-choice";

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** What the network is, in a sentence. */
function about(net: NetworkProfile): string {
  if (net.builtin === "local") return "Devices find each other on this network. Nothing leaves it. Devices outside it can't connect.";
  return `Run by its admin, who signed it (${net.admin?.slice(0, 8)}…). Only its servers are used.`;
}

export function ServersPrefs() {
  // undefined while it is asked for; null where no app answers, or hive-net is not installed.
  const [net, setNet] = useState<NetworkProfile | null | undefined>(undefined);
  const [health, setHealth] = useState<NetworkHealth | null>(null);
  const [checking, setChecking] = useState(false);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try { setHealth(await window.hive.networkHealth()); } catch (e) { setError(messageOf(e)); } finally { setChecking(false); }
  }, []);
  // Shown and checked as the page opens, and again when the network changes, here or by an agent
  // running `hive network use`.
  useEffect(() => {
    const load = () => void window.hive.network().then((n) => {
      setNet(n ?? null);
      setHealth(null);
      if (n && (n.profile.relays.length > 0 || n.profile.lookup)) void check();
    }, (e: unknown) => { setNet(null); setError(messageOf(e)); });
    load();
    return window.hive.onNetworkChanged(load);
  }, [check]);
  const [admission, setAdmission] = useState<string | null>(null);
  const chosen = (next: NetworkProfile & { admission?: string }) => {
    setNet(next);
    setHealth(null);
    setChanging(false);
    setAdmission(next.admission && next.admission !== "none needed" ? `This computer: ${next.admission}.` : null);
  };
  const relay = (url: string) => health?.relays.find((r) => r.url.replace(/\/$/, "") === url.replace(/\/$/, ""));
  const ok = (url: string) => relay(url)?.ok;
  const mark = (answered: boolean | undefined) =>
    answered === true ? <Check size={13} className="text-[var(--color-ok)]" /> : answered === false ? <X size={13} className="text-[var(--color-err)]" /> : <span className="w-[13px]" />;
  const servers = (net?.profile.relays.length ?? 0) > 0 || !!net?.profile.lookup;

  return (
    <div className="settings-stack">
      {net?.builtin === "local" && (
        <Section title="Reach your devices from anywhere" hint="Your phone and other computers reach this one only on this network now. An agent sets up your own server here, checks it answers, and asks you for anything only you can do.">
          <div data-servers-setup>
            <StartAgentWith label="Set up my server with an agent" work={SET_UP_SERVER} variant="default" size="default" data-serve-with-agent />
          </div>
        </Section>
      )}
      <Section title="Relay and discovery" hint="How this computer finds and reaches your other devices. Most people never change this.">
        {net === undefined ? null : net === null ? (
          <p className="settings-note">{error ?? "Only the app knows"}</p>
        ) : (
          <div className="flex flex-col gap-3" data-network={net.builtin ?? "signed"}>
            <div>
              <div className="text-row font-medium" data-network-name>{net.profile.name}</div>
              <p className="text-label text-[var(--color-fg3)]">{about(net)}</p>
            </div>
            {servers && (
              <ul className="flex flex-col gap-1 text-label" data-network-relays>
                {net.profile.relays.map((r) => (
                  <li key={r.url} className="flex items-center gap-2" data-relay={r.url} data-ok={String(ok(r.url) ?? "")}>
                    {mark(ok(r.url))}
                    <span className="text-[var(--color-fg3)]">Relay</span>
                    <code className="truncate font-mono text-count">{r.url}</code>
                    {relay(r.url)?.refused && <span className="text-[var(--color-err)]" data-relay-refused>turned this computer away: {relay(r.url)!.refused}</span>}
                  </li>
                ))}
                {net.profile.lookup && (
                  <li className="flex items-center gap-2" data-lookup={net.profile.lookup} data-ok={String(health?.lookup?.ok ?? "")}>
                    {mark(health?.lookup?.ok)}
                    <span className="text-[var(--color-fg3)]">Finds devices at</span>
                    <code className="truncate font-mono text-count">{net.profile.lookup}</code>
                  </li>
                )}
                {net.profile.access && (
                  <li className="flex items-center gap-2" data-access data-ok={String(health?.access?.ok ?? "")}>
                    {mark(health?.access?.ok)}
                    <span className="text-[var(--color-fg3)]">Who may use them: {net.profile.access.policy === "closed" ? "devices its admin lets in" : "any device that registers"}</span>
                  </li>
                )}
              </ul>
            )}
            <div className="flex gap-2">
              {servers && <Button variant="outline" onClick={() => void check()} disabled={checking} data-network-check>{checking ? "Checking…" : "Check"}</Button>}
              <Button variant="outline" onClick={() => setChanging((c) => !c)} data-network-change>Change…</Button>
            </div>
            {changing && <ReachChooser current={net} onChosen={chosen} onCancel={() => setChanging(false)} />}
            {admission && <p className="text-label text-[var(--color-fg3)]" data-network-admission>{admission}</p>}
          </div>
        )}
        {net && error && <p className="text-label text-[var(--color-err)]" role="alert">{error}</p>}
      </Section>
    </div>
  );
}
