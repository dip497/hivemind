/**
 * Settings → Your devices (R14, M3, M5, spec/pairing.md): using this app elsewhere, by what the
 * person wants to do. On a phone: it scans this computer's code, is certified as yours, and runs
 * nothing. On another computer, or a host (`hive host` on a server, a VPS, a box in the office):
 * enter the six words or the link one shows (found on this network, or from anywhere), or show a
 * code from here; a host takes your person, another computer entering this one's code does too,
 * and this computer entering another's becomes its person, so the workspaces each holds are yours
 * and open from Open recent. In a browser on this computer: the app served to a tab
 * (docs/design/browser-app-2026-10-13.md). Then the devices paired with this one.
 */
import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { Check, ChevronDown, Copy, Globe, Laptop, Server, Smartphone } from "./components/icons";
import { encode } from "uqr";
import type { BrowserAppStatus, PairedDeviceSummary } from "../../shared/ipc";
import { patchSettings, useSettings } from "./settings-store";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Section, Switch } from "./appearance-controls";

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

type Offer = { code: string; link: string; page?: string; expires: number; phone: boolean };
/** This computer keeps one code open: the phone's and another computer's are the same offer. */
type Offering = { offer: Offer | null; error: string | null; show(phone: boolean): void };

function useOffering(): Offering {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const show = (phone: boolean) => {
    setError(null);
    window.hive.pairOffer().then((o) => setOffer({ ...o, phone }), (e: unknown) => setError(messageOf(e)));
  };
  return { offer, error, show };
}

export function YourDevicesPrefs() {
  // undefined while it is asked for; null where no app answers (a window in a browser).
  const [devices, setDevices] = useState<PairedDeviceSummary[] | null | undefined>(undefined);
  const offering = useOffering();
  useEffect(() => {
    const load = () => void window.hive.devices().then((d) => setDevices(d ?? null), () => setDevices(null));
    load();
    return window.hive.onDevicesChanged?.(load);
  }, []);
  return (
    <div className="settings-stack">
      <div className="flex flex-col gap-3" data-connect-cards>
        <Card icon={Smartphone} title="Use on your phone" what="Scan a code with it. Your phone sees what needs you and answers it; it runs nothing itself." name="phone">
          <PhoneCode offering={offering} />
        </Card>
        <Card icon={Laptop} title="Another computer" what="Pair with a code; each can then open the other's workspaces." name="computer">
          <ComputerCode offering={offering} />
        </Card>
        <Card icon={Globe} title="In a browser on this computer" what="This app, whole, in a browser tab here." name="browser">
          <BrowserApp />
        </Card>
      </div>
      <Section title="Paired" hint="The phones, computers and hosts that are you">
        {devices === undefined ? null : devices === null ? (
          <p className="settings-note">Only the app knows</p>
        ) : devices.length === 0 ? (
          <p className="text-[12px] text-[var(--color-fg3)]" data-devices-none>None yet.</p>
        ) : (
          <ul className="flex flex-col" data-devices>
            {devices.map((d) => <DeviceRow key={d.device} device={d} />)}
          </ul>
        )}
      </Section>
    </div>
  );
}

/** One way to use the app elsewhere: what it is, in a line, and how. */
function Card({ icon: Icon, title, what, name, children }: { icon: ComponentType<{ size?: number; className?: string }>; title: string; what: string; name: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg2)] p-4" data-connect={name}>
      <div className="flex items-start gap-3">
        <Icon size={18} className="mt-0.5 shrink-0 text-[var(--color-fg2)]" />
        <div className="flex flex-col gap-0.5">
          <h3 className="text-[13px] font-semibold">{title}</h3>
          <p className="text-[12px] text-[var(--color-fg3)]">{what}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

/** How each kind of device is shown. A phone's name says which browser, when it paired from one. */
const KINDS = {
  host: { Icon: Server, what: "Always on" },
  app: { Icon: Laptop, what: "A computer" },
  phone: { Icon: Smartphone, what: "Phone or browser" },
} as const;

function DeviceRow({ device }: { device: PairedDeviceSummary }) {
  const [error, setError] = useState<string | null>(null);
  const { Icon, what } = KINDS[device.kind];
  return (
    <li className="settings-row" data-device={device.device} data-device-kind={device.kind}>
      <div className="flex items-center gap-2.5">
        <Icon size={15} className="text-[var(--color-fg3)]" />
        <div>
          <label>{device.name}</label>
          <p>
            {what} · paired {new Date(device.pairedAt).toLocaleDateString()}
            {error && <span className="text-[var(--color-err)]" role="alert"> · {error}</span>}
          </p>
        </div>
      </div>
      <Button size="sm" variant="outline" data-unpair onClick={() => void window.hive.unpair(device.device).catch((e: unknown) => setError(messageOf(e)))}>
        Unpair
      </Button>
    </li>
  );
}

/** The phone's code: a QR code to scan, and, asked for, the network's page for a phone without the app. */
function PhoneCode({ offering }: { offering: Offering }) {
  const [inBrowser, setInBrowser] = useState(false);
  const { offer, error, show } = offering;
  if (!offer?.phone) {
    return (
      <div className="flex flex-col gap-2">
        <div><Button size="sm" data-pair-phone onClick={() => { setInBrowser(false); show(true); }}><Smartphone /> Show the code</Button></div>
        {error && <p className="text-[12px] text-[var(--color-err)]" role="alert">{error}</p>}
      </div>
    );
  }
  const until = new Date(offer.expires).toLocaleTimeString();
  // A phone without hivemind opens the page's address in its browser; hivemind reads it as the link.
  // Asked for, never the default: the page comes from the network's server, whose operator could
  // pair as this person with the link it is given.
  const page = offer.page;
  const shown = page && inBrowser ? page : offer.link;
  const server = page && new URL(page).host;
  return (
    <div className="flex items-start gap-4" data-pair-offered="phone">
      <Qr text={shown} />
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-[12px] text-[var(--color-fg2)]">
          {shown === page ? "Scan this with your phone's camera, or with hivemind on it." : "Scan this with hivemind on your phone."} It works once, until {until}.
        </p>
        {page && (
          <div className="flex flex-col gap-1" data-pair-browser={inBrowser ? "on" : "off"}>
            <label className="flex items-center gap-2 text-[12px]">
              <Switch on={inBrowser} onChange={setInBrowser} label="Open in the phone's browser" /> Open in the phone's browser, no app needed
            </label>
            <p className="text-[12px] text-[var(--color-fg3)]" data-pair-server={server}>
              The page comes from {server}, this network's server. Whoever runs it could pair as you: turn this on only if that is you.
            </p>
            {inBrowser && <PageHash page={page.split("#")[0]!} />}
          </div>
        )}
        <CopyLink text={shown} />
      </div>
    </div>
  );
}

/** Another computer or a host: show this computer's code, or enter the one it shows. */
function ComputerCode({ offering }: { offering: Offering }) {
  const { offer, error, show } = offering;
  return (
    <div className="flex flex-col gap-3">
      {offer && !offer.phone ? (
        <div className="flex items-start gap-4" data-pair-offered="code">
          <Qr text={offer.link} />
          <div className="flex min-w-0 flex-col gap-2">
            <p className="font-mono text-[14px] tracking-wide" data-pair-code>{offer.code.split("-").join(" ")}</p>
            <p className="text-[12px] text-[var(--color-fg3)]">
              Enter these words (on this network) or the link on the other computer, under Settings → Your devices, or run <code className="font-mono">hive host pair</code> with them on a host. It works once, until {new Date(offer.expires).toLocaleTimeString()}.
            </p>
            <CopyLink text={offer.link} />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div><Button size="sm" variant="outline" data-pair-offer onClick={() => show(false)}>Show a code</Button></div>
          {error && <p className="text-[12px] text-[var(--color-err)]" role="alert">{error}</p>}
        </div>
      )}
      <EnterLink />
      <details className="settings-disclosure" data-pairing-how>
        <summary>How pairing works <ChevronDown size={14} /></summary>
        <div className="flex flex-col gap-1.5 text-[12px] text-[var(--color-fg3)]">
          <p>The six words find the other device on this network; the link finds it from anywhere.</p>
          <p>A host (<code className="font-mono">hive host</code> on a server) keeps your workspaces, and their agents, running while this computer sleeps. It becomes you: it can open, and run agents in, every workspace you own there.</p>
          <p>Entering another computer's code makes this computer that person.</p>
        </div>
      </details>
    </div>
  );
}

function CopyLink({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <Button size="sm" variant="outline" data-pair-copy title={text}
        onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
        Copy the link {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

/** The words or the link another device shows, entered here: a host takes this person, and another
 *  computer gives its own, which this computer takes. */
function EnterLink() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const pair = async () => {
    setBusy(true);
    setResult(null);
    try {
      const d = await window.hive.pairEnter(text.trim());
      setResult({
        ok: true,
        message: d.took
          ? `Paired with ${d.name}: this computer is you there too, and the workspaces here are yours on it. Its workspaces are under Open recent.`
          : `Paired with ${d.name}. Its workspaces are under Open recent.`,
      });
      setText("");
    } catch (e) {
      setResult({ ok: false, message: messageOf(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input
          value={text}
          placeholder="or enter the six words, or hivemind://pair/…, it shows"
          spellCheck={false}
          autoComplete="off"
          className="flex-1 font-mono text-[12px]"
          data-pair-link
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && text.trim() && !busy) void pair(); }}
        />
        <Button size="sm" disabled={!text.trim() || busy} data-pair-go onClick={() => void pair()}>{busy ? "Pairing…" : "Pair"}</Button>
      </div>
      {result && (
        <p className={`text-[12px] ${result.ok ? "text-[var(--color-ok)]" : "text-[var(--color-err)]"}`} role={result.ok ? "status" : "alert"} data-pair-result={result.ok ? "paired" : "failed"}>
          {result.message}
        </p>
      )}
    </div>
  );
}

/** The hash of the phone page `page` serves, and whether it is the page this release made. */
function PageHash({ page }: { page: string }) {
  const [hash, setHash] = useState<{ served: string; shipped: string | null } | { error: string } | null>(null);
  useEffect(() => {
    let on = true;
    window.hive.phonePage(page).then((h) => on && setHash(h), (e: unknown) => on && setHash({ error: messageOf(e) }));
    return () => { on = false; };
  }, [page]);
  const short = (h: string) => `${h.slice(0, 16)}…`;
  if (!hash) return <p className="text-[12px] text-[var(--color-fg3)]">Working out the page's hash…</p>;
  if ("error" in hash) return <p className="text-[12px] text-[var(--color-err)]" data-pair-page="error">The page's hash could not be worked out: {hash.error}</p>;
  const { served, shipped } = hash;
  const verdict = shipped === null ? "unknown" : served === shipped ? "same" : "other";
  return (
    <p className="text-[12px] text-[var(--color-fg3)]" data-pair-page={verdict} title={served}>
      Page <span className="font-mono">{short(served)}</span>
      {verdict === "same" && ": the page this release of hivemind made."}
      {verdict === "other" && <span className="text-[var(--color-err)]">: not the page this release made (<span className="font-mono">{short(shipped!)}</span>). It is another version, or was changed.</span>}
      {verdict === "unknown" && ": compare it with hive-phone-page.sha256 on the release."}
    </p>
  );
}

/** A QR code of `text`, drawn from its modules. */
function Qr({ text }: { text: string }) {
  const { data, size } = useMemo(() => encode(text, { border: 2 }), [text]);
  const cells: string[] = [];
  data.forEach((row, y) => row.forEach((on, x) => { if (on) cells.push(`M${x} ${y}h1v1h-1z`); }));
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={168} height={168} shapeRendering="crispEdges" className="shrink-0 rounded bg-white" aria-label="QR code of the pairing link" data-pair-qr>
      <path d={cells.join("")} fill="#000" />
    </svg>
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
          <code className="min-w-0 flex-1 truncate text-[12px]" data-browser-app-url>{status.url.replace(/#token=.*/, "#token=…")}</code>
          <Button size="sm" variant="outline" data-browser-app-copy
            onClick={() => { void navigator.clipboard.writeText(status.url!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
            Copy the link {copied ? <Check /> : <Copy />}
          </Button>
          <Button size="sm" variant="outline" asChild><a href={status.url} target="_blank" rel="noopener noreferrer" data-browser-app-open>Open</a></Button>
        </div>
      )}
      {status?.error && <p className="text-[12px] text-[var(--color-err)]" role="alert" data-browser-app-error>{status.error}</p>}
      <details className="settings-disclosure" data-browser-app-more>
        <summary>More options <ChevronDown size={14} /></summary>
        <p className="text-[12px] text-[var(--color-fg3)]">For another device, put the app behind <code>tailscale serve</code> and add the machine's tailnet name under Other names.</p>
        <div className="settings-row">
          <label htmlFor="browser-app-port">Port</label>
          <Input id="browser-app-port" className="h-8 w-28" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} onBlur={savePort}
            onKeyDown={(e) => { if (e.key === "Enter") savePort(); }} />
        </div>
        <div className="settings-row">
          <label htmlFor="browser-app-names">Other names</label>
          <Input id="browser-app-names" className="h-8 flex-1" placeholder="box.tail1234.ts.net" spellCheck={false} value={names} onChange={(e) => setNames(e.target.value)} onBlur={saveNames}
            onKeyDown={(e) => { if (e.key === "Enter") saveNames(); }} />
        </div>
      </details>
    </div>
  );
}
