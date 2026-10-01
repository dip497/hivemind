/**
 * Settings → Devices (R14, spec/pairing.md): the person's other devices this computer is paired
 * with, and pairing another. A host (`hive host` on a server, a VPS, a box in the office) takes
 * your person, so the workspaces it holds are yours and open from Open recent: enter the six words
 * its `hive host pair` prints (found on this network) or its link (from anywhere), or show it a
 * code from here for `hive host pair <words or link>`.
 */
import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Laptop, Server } from "lucide-react";
import { encode } from "uqr";
import type { PairedDeviceSummary } from "../../shared/ipc";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Section } from "./appearance-controls";

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

export function DevicesPrefs() {
  // undefined while it is asked for; null where no app answers (a window in a browser).
  const [devices, setDevices] = useState<PairedDeviceSummary[] | null | undefined>(undefined);
  useEffect(() => {
    const load = () => void window.hive.devices().then((d) => setDevices(d ?? null), () => setDevices(null));
    load();
    return window.hive.onDevicesChanged?.(load);
  }, []);
  return (
    <div className="settings-stack">
      <Section title="Your devices" hint="Hosts and computers that are you">
        {devices === undefined ? null : devices === null ? (
          <p className="settings-note">Only the app knows</p>
        ) : devices.length === 0 ? (
          <p className="text-[12px] text-[var(--color-fg3)]" data-devices-none>
            None yet. Pair a host to keep your workspaces, and the agents in them, running while this computer sleeps.
          </p>
        ) : (
          <ul className="flex flex-col" data-devices>
            {devices.map((d) => <DeviceRow key={d.device} device={d} />)}
          </ul>
        )}
      </Section>
      <Section title="Pair with a host" hint="On the host: hive host pair">
        <EnterLink />
      </Section>
      <Section title="Or show a host a code" hint="On the host: hive host pair <words or link>">
        <OfferCode />
      </Section>
    </div>
  );
}

function DeviceRow({ device }: { device: PairedDeviceSummary }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="settings-row" data-device={device.device} data-device-kind={device.kind}>
      <div className="flex items-center gap-2.5">
        {device.kind === "host" ? <Server size={15} className="text-[var(--color-fg3)]" /> : <Laptop size={15} className="text-[var(--color-fg3)]" />}
        <div>
          <label>{device.name}</label>
          <p>
            {device.kind === "host" ? "Always on" : "A computer"} · paired {new Date(device.pairedAt).toLocaleDateString()}
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

/** The words or the link a host's `hive host pair` prints, entered here: the host takes this person. */
function EnterLink() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const pair = async () => {
    setBusy(true);
    setResult(null);
    try {
      const d = await window.hive.pairEnter(text.trim());
      setResult({ ok: true, message: `Paired with ${d.name}. Its workspaces are under Open recent.` });
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
          placeholder="six words, or hivemind://pair/…"
          spellCheck={false}
          autoComplete="off"
          className="flex-1 font-mono text-[12px]"
          data-pair-link
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && text.trim() && !busy) void pair(); }}
        />
        <Button size="sm" disabled={!text.trim() || busy} data-pair-go onClick={() => void pair()}>{busy ? "Pairing…" : "Pair"}</Button>
      </div>
      <p className="text-[12px] text-[var(--color-fg3)]">
        The six words find a host on this network; the link finds it from anywhere. The host becomes you: it can open, and run agents in, every workspace you own there.
      </p>
      {result && (
        <p className={`text-[12px] ${result.ok ? "text-[var(--color-ok)]" : "text-[var(--color-err)]"}`} role={result.ok ? "status" : "alert"} data-pair-result={result.ok ? "paired" : "failed"}>
          {result.message}
        </p>
      )}
    </div>
  );
}

/** A code for a host to enter: shown as its words, a link and a QR code of the link. */
function OfferCode() {
  const [offer, setOffer] = useState<{ code: string; link: string; expires: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const show = async () => {
    setError(null);
    try { setOffer(await window.hive.pairOffer()); } catch (e) { setError(messageOf(e)); }
  };
  if (!offer) {
    return (
      <div className="flex flex-col gap-2">
        <div><Button size="sm" variant="outline" data-pair-offer onClick={() => void show()}>Show a code</Button></div>
        {error && <p className="text-[12px] text-[var(--color-err)]" role="alert">{error}</p>}
      </div>
    );
  }
  return (
    <div className="flex items-start gap-4" data-pair-offered>
      <Qr text={offer.link} />
      <div className="flex min-w-0 flex-col gap-2">
        <p className="font-mono text-[14px] tracking-wide" data-pair-code>{offer.code.split("-").join(" ")}</p>
        <p className="text-[12px] text-[var(--color-fg3)]">
          On the host, run <code className="font-mono">hive host pair</code> with these words (on this network) or the link. It works once, until {new Date(offer.expires).toLocaleTimeString()}.
        </p>
        <div>
          <Button size="sm" variant="outline" data-pair-copy title={offer.link}
            onClick={() => { void navigator.clipboard.writeText(offer.link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
            Copy the link {copied ? <Check /> : <Copy />}
          </Button>
        </div>
      </div>
    </div>
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
