/**
 * Settings → Devices (R14, M3, M5, spec/pairing.md): the person's other devices this computer is
 * paired with, and pairing another. A host (`hive host` on a server, a VPS, a box in the office)
 * takes your person; another computer entering this one's code does too, and this computer
 * entering another's becomes its person. Either way the workspaces each holds are yours, and open
 * from Open recent. A phone scans this computer's code and is certified as yours; it runs nothing.
 * Enter the six words the other device shows (found on this network) or its link (from anywhere),
 * or show a code from here.
 */
import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Laptop, Server, Smartphone } from "lucide-react";
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
      <Section title="Your devices" hint="Hosts, computers and phones that are you">
        {devices === undefined ? null : devices === null ? (
          <p className="settings-note">Only the app knows</p>
        ) : devices.length === 0 ? (
          <p className="text-[12px] text-[var(--color-fg3)]" data-devices-none>
            None yet. Pair your other computers to open each one's workspaces from the other, a host to keep them, and the agents in them, running while this computer sleeps, and your phone to see what needs you.
          </p>
        ) : (
          <ul className="flex flex-col" data-devices>
            {devices.map((d) => <DeviceRow key={d.device} device={d} />)}
          </ul>
        )}
      </Section>
      <Section title="Pair with a device" hint="Another computer's Settings → Devices, or hive host pair on a host">
        <EnterLink />
      </Section>
      <Section title="Or show a code" hint="For another computer, a phone, or hive host pair <words or link> on a host">
        <OfferCode />
      </Section>
    </div>
  );
}

/** How each kind of device is shown. */
const KINDS = {
  host: { Icon: Server, what: "Always on" },
  app: { Icon: Laptop, what: "A computer" },
  phone: { Icon: Smartphone, what: "A phone" },
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
        The six words find the device on this network; the link finds it from anywhere. A host becomes you: it can open, and run agents in, every workspace you own there. Entering another computer's code makes this computer that person.
      </p>
      {result && (
        <p className={`text-[12px] ${result.ok ? "text-[var(--color-ok)]" : "text-[var(--color-err)]"}`} role={result.ok ? "status" : "alert"} data-pair-result={result.ok ? "paired" : "failed"}>
          {result.message}
        </p>
      )}
    </div>
  );
}

/** A code for another device to enter: shown as its words, a link and a QR code of the link; for a
 *  phone, the QR code to scan. One at a time: this computer keeps one code open. */
function OfferCode() {
  const [offer, setOffer] = useState<{ code: string; link: string; expires: number; phone: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const show = async (phone: boolean) => {
    setError(null);
    try { setOffer({ ...(await window.hive.pairOffer()), phone }); } catch (e) { setError(messageOf(e)); }
  };
  if (!offer) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <Button size="sm" variant="outline" data-pair-offer onClick={() => void show(false)}>Show a code</Button>
          <Button size="sm" variant="outline" data-pair-phone onClick={() => void show(true)}><Smartphone /> Pair a phone</Button>
        </div>
        {error && <p className="text-[12px] text-[var(--color-err)]" role="alert">{error}</p>}
      </div>
    );
  }
  const until = new Date(offer.expires).toLocaleTimeString();
  return (
    <div className="flex items-start gap-4" data-pair-offered={offer.phone ? "phone" : "code"}>
      <Qr text={offer.link} />
      <div className="flex min-w-0 flex-col gap-2">
        {offer.phone ? (
          <p className="text-[12px] text-[var(--color-fg2)]">
            Scan this with hivemind on your phone. It becomes yours, to see what needs you and answer it, and runs nothing itself. It works once, until {until}.
          </p>
        ) : (
          <>
            <p className="font-mono text-[14px] tracking-wide" data-pair-code>{offer.code.split("-").join(" ")}</p>
            <p className="text-[12px] text-[var(--color-fg3)]">
              Enter these words (on this network) or the link on the other computer, under Settings → Devices, or run <code className="font-mono">hive host pair</code> with them on a host. It works once, until {until}.
            </p>
          </>
        )}
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
