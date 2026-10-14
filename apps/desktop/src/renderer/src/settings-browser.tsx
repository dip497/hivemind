/**
 * Settings → Advanced → In a browser (docs/design/browser-app-2026-10-13.md): this app, whole, served
 * to a browser tab on this computer, behind a key that changes each launch.
 */
import { useEffect, useState } from "react";
import { Check, ChevronDown, Copy } from "./components/icons";
import type { BrowserAppStatus } from "../../shared/ipc";
import { patchSettings, useSettings } from "./settings-store";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Switch } from "./appearance-controls";

export function BrowserPrefs() {
  return (
    <div className="settings-stack">
      <p className="text-body text-[var(--color-fg2)]" data-page-lead>This app, whole, in a browser tab on this computer.</p>
      <BrowserApp />
    </div>
  );
}

/** The app served to a browser: a switch, the link that signs a tab in, and what it answers to. */
function BrowserApp() {
  const { browserApp } = useSettings();
  const [status, setStatus] = useState<BrowserAppStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const [port, setPort] = useState(String(browserApp.port));
  const [names, setNames] = useState(browserApp.names.join(", "));
  useEffect(() => {
    void window.hive.browserAppStatus().then(setStatus, () => setStatus(null));
    return window.hive.onBrowserAppChanged(setStatus);
  }, []);
  useEffect(() => { setPort(String(browserApp.port)); setNames(browserApp.names.join(", ")); }, [browserApp.port, browserApp.names]);
  const savePort = () => {
    const n = Number(port);
    if (Number.isInteger(n) && n >= 1024 && n <= 65535) patchSettings("browserApp.port", n);
    else setPort(String(browserApp.port));
  };
  const saveNames = () => patchSettings("browserApp.names", names.split(/[\s,]+/).filter(Boolean));
  return (
    <div className="flex flex-col gap-2" data-browser-app>
      <div className="settings-row">
        <div>
          <label>Serve the app to a browser</label>
          <p>On 127.0.0.1 only. The link carries a key that changes each time the app starts: whoever has it can use your terminals.</p>
        </div>
        <Switch on={browserApp.enabled} onChange={(v) => patchSettings("browserApp.enabled", v)} label="Serve the app to a browser" />
      </div>
      {status?.url && (
        <div className="settings-row">
          <code className="min-w-0 flex-1 truncate text-label" data-browser-app-url>{status.url.replace(/#token=.*/, "#token=…")}</code>
          <Button variant="outline" data-browser-app-copy
            onClick={() => { void navigator.clipboard.writeText(status.url!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
            Copy the link {copied ? <Check /> : <Copy />}
          </Button>
          <Button variant="outline" asChild><a href={status.url} target="_blank" rel="noopener noreferrer" data-browser-app-open>Open</a></Button>
        </div>
      )}
      {status?.error && <p className="text-label text-[var(--color-err)]" role="alert" data-browser-app-error>{status.error}</p>}
      <details className="settings-disclosure" data-browser-app-more>
        <summary>More options <ChevronDown size={14} /></summary>
        <p className="text-label text-[var(--color-fg3)]">For another device, put the app behind <code>tailscale serve</code> and add the machine's tailnet name under Other names.</p>
        <div className="settings-row">
          <label htmlFor="browser-app-port">Port</label>
          <Input id="browser-app-port" className="w-28" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} onBlur={savePort}
            onKeyDown={(e) => { if (e.key === "Enter") savePort(); }} />
        </div>
        <div className="settings-row">
          <label htmlFor="browser-app-names">Other names</label>
          <Input id="browser-app-names" className="flex-1" placeholder="box.tail1234.ts.net" spellCheck={false} value={names} onChange={(e) => setNames(e.target.value)} onBlur={saveNames}
            onKeyDown={(e) => { if (e.key === "Enter") saveNames(); }} />
        </div>
      </details>
    </div>
  );
}
