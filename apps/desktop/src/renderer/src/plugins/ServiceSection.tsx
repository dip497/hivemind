/**
 * A tool plugin's service on its page (docs/design/drive-api-2026-10-09.md, D8): what it runs and
 * may do, the workspaces it may drive (none until picked), how it is, and the end of its log.
 */
import { useEffect, useState } from "react";
import { serviceWorkspaces } from "@hivemind/core/plugin-settings";
import type { ToolService } from "@hivemind/core/tool-format";
import type { ServiceState } from "@hivemind/host/services";
import { Switch } from "../components/ui/switch";
import { setServiceWorkspaces, useSettings } from "../settings-store";
import { ROLE_WORDS } from "../settings-programs";

const folder = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function stateWords(on: boolean, s: ServiceState | undefined, now: number): string {
  if (!on) return "Off: switch the plugin on to run it.";
  if (!s) return "Not running.";
  if (s.state === "running") return `Running since ${clock(s.since)}.`;
  if (s.state === "restarting") return `Starts again in ${Math.max(1, Math.ceil(((s.restartAt ?? now) - now) / 1000))} s: ${s.why}.`;
  return `Stopped: ${s.why}.`;
}

export function ServiceSection({ id, service, on }: { id: string; service: ToolService; on: boolean }) {
  const picked = serviceWorkspaces(useSettings().plugins.state, id);
  const [here, setHere] = useState<string[]>([]);
  const [state, setState] = useState<ServiceState | undefined>();
  const [log, setLog] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let live = true;
    // A workspace joined from someone else's machine is not one a grant here can name.
    void window.hive.hostWorkspaces().then((l) => { if (live) setHere(l.filter((r) => !r.startsWith("hive://"))); }, () => {});
    const read = () => {
      setNow(Date.now());
      void window.hive.services().then((l) => { if (live) setState(l.find((s) => s.plugin === id)); }, () => {});
      void window.hive.serviceLog(id).then((t) => { if (live) setLog(t); }, () => {});
    };
    read();
    const off = window.hive.onServicesChanged(read);
    // What it prints arrives without a change of state.
    const every = setInterval(read, 2_000);
    return () => { live = false; off(); clearInterval(every); };
  }, [id]);
  // The workspaces here, and any picked one not open now, which its grant still names.
  const places = [...new Set([...here, ...picked])].map((repo) => ({ repo, title: folder(repo) }));
  const role = (ROLE_WORDS as Record<string, string>)[service.role] ?? service.role;
  return <section className="plugin-section" aria-label="Its service" data-service={id}>
    <h3>Its service</h3>
    <p className="settings-note">
      While it is on, it runs <code>{service.command.join(" ")}</code> in its folder, with its own token for the workspaces you pick here: {role.toLowerCase()}, and nothing in any other.
    </p>
    {places.length === 0
      ? <p className="settings-note">Open a workspace on this computer to pick it.</p>
      : places.map((w) => {
        const has = picked.includes(w.repo);
        return <div key={w.repo} className="settings-row" data-service-workspace={w.repo}>
          <div className="flex-1 min-w-0"><label>{w.title}</label><p className="settings-path">{w.repo}</p></div>
          <Switch aria-label={`Let it drive ${w.title}`} checked={has} onCheckedChange={() => setServiceWorkspaces(id, has ? picked.filter((r) => r !== w.repo) : [...picked, w.repo])} />
        </div>;
      })}
    <p role="status" className="settings-note" data-service-state={on ? state?.state ?? "none" : "off"}>{stateWords(on, state, now)}</p>
    {log
      ? <pre className="service-log" data-service-log>{log}</pre>
      : <p className="settings-note">It has printed nothing yet.</p>}
  </section>;
}
