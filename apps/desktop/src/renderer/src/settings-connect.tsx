/**
 * Settings → Connect (docs/design/connect-2026-10-13.md §5.4): one offer, for another computer, a
 * phone or someone else, decided when it is used (the prompt, multiplayer/requests.tsx); a code from
 * elsewhere, entered under Join; and who is connected: the devices that are you, and the people in
 * the workspace this window shows, with where it runs.
 */
import { useEffect, useState } from "react";
import { Check, Copy, Laptop, Server, Smartphone } from "./components/icons";
import { QrCode } from "./components/qr-code";
import type { ConnectState, PairedDeviceSummary } from "../../shared/ipc";
import type { NetworkProfile } from "@hivemind/workspace-host/network-profile";
import { Button } from "./components/ui/button";
import { PeopleList } from "./multiplayer/people-list";
import { Hosting } from "./multiplayer/hosting";
import { useShown } from "./multiplayer/shown";
import { useCanShare } from "./multiplayer/workspace-actions";
import { ReachChooser, SET_UP_SERVER } from "./multiplayer/reach-chooser";
import { StartAgentWith } from "./agent-choice";
import { ConnectRequest, answerRequest, useRequestsShownHere } from "./multiplayer/requests";

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** Open recent's Join, where a link or six words from elsewhere are entered. */
export const openJoin = () => window.dispatchEvent(new CustomEvent("hivemind:open-recent", { detail: { join: true } }));

export function ConnectPrefs() {
  const { repo } = useShown();
  const owner = useCanShare();
  const here = repo && !repo.startsWith("hive://") ? repo : null;
  return (
    <div className="settings-stack" data-connect-page>
      <p className="text-body text-[var(--color-fg2)]" data-page-lead>
        Another computer, a phone, or someone else uses this computer's offer; you say who they are when they do.
      </p>
      <Offer repo={owner ? here : null} />
      <Asking />
      <div className="flex flex-wrap items-center gap-2" data-connect-join>
        <span className="text-label text-[var(--color-fg2)]">Have a code?</span>
        <Button variant="outline" size="sm" onClick={openJoin} data-connect-join-open>Join</Button>
      </div>
      <Connected repo={repo} owner={owner} hostedHere={!!here} />
    </div>
  );
}

/** The offer: made with a press, shown until it is used, cancelled or a day has passed. */
function Offer({ repo }: { repo: string | null }) {
  const [state, setState] = useState<ConnectState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inBrowser, setInBrowser] = useState(false);
  const [net, setNet] = useState<NetworkProfile | null>(null);
  const [reaching, setReaching] = useState(false);
  useEffect(() => {
    void window.hive.connectState().then(setState, () => setState(null));
    void window.hive.network().then(setNet, () => setNet(null));
    return window.hive.onConnectChanged(setState);
  }, []);
  const make = () => {
    setError(null);
    setInBrowser(false);
    window.hive.connectOffer(repo).catch((e: unknown) => setError(messageOf(e)));
  };
  const offer = state?.offer;
  if (!offer) {
    return (
      <section className="flex flex-col gap-2" aria-label="Connect" data-connect-offer-none>
        <p className="text-label text-[var(--color-fg2)]">
          Shows a code for the other device to use. {repo ? "Someone else is let into this window's workspace, at the role you choose then." : "Open a workspace of yours first to let someone else into it."}
        </p>
        <div><Button onClick={make} data-connect-offer>Connect</Button></div>
        {net?.builtin === "local" && (reaching
          ? <ReachChooser current={net} onChosen={(n) => { setNet(n); setReaching(false); }} onCancel={() => { setReaching(false); setError("Stays on this network: the code works only here."); }} />
          : <p className="text-label text-[var(--color-fg3)]" data-connect-reach>
              Works on this network only. <Button variant="link" size="xs" onClick={() => setReaching(true)} data-connect-elsewhere>Reach devices elsewhere…</Button>
            </p>)}
        {error && <p className="text-label text-[var(--color-err)]" role="alert">{error}</p>}
      </section>
    );
  }
  // A phone without hivemind opens the page in its browser; asked for, never the default: the page
  // comes from the network's server, whose operator is given the code with it.
  const page = offer.page;
  const shown = inBrowser ? page : offer.link;
  const server = page && new URL(page).host;
  const until = new Date(offer.expires).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  const cancel = <Button variant="ghost" onClick={() => void window.hive.connectCancel()} data-connect-cancel>Cancel</Button>;
  return (
    <section className="flex flex-col gap-3" aria-label="Connect" data-connect-offered>
      <div role="tablist" aria-label="Open with" className="plugins-scope self-start">
        <button type="button" role="tab" aria-selected={!inBrowser} data-connect-way="app" onClick={() => setInBrowser(false)}>Hivemind app</button>
        <button type="button" role="tab" aria-selected={inBrowser} data-connect-way="browser" onClick={() => setInBrowser(true)}>Phone browser</button>
      </div>
      {shown ? (
        <div className="flex flex-wrap items-start gap-4">
          <QrCode text={shown} label="QR code of the offer to connect" data-connect-qr />
          <div className="flex min-w-[200px] flex-1 flex-col gap-2">
            {inBrowser ? (
              <>
                <p className="text-label text-[var(--color-fg2)]">
                  Scan the code with the phone's camera, or send it the link: it opens in the browser, no app needed.
                  You are asked who it is when it does. Until {until}, or once used.
                </p>
                <p className="text-label text-[var(--color-fg3)]" data-connect-server={server}>
                  The page comes from {server}, this network's server. Whoever runs it is given the code with it: use this only if that is you.
                </p>
                <PageHash page={page!.split("#")[0]!} />
              </>
            ) : (
              <>
                <p className="font-mono text-row tracking-wide" data-connect-code>{offer.code.split("-").join(" ")}</p>
                <p className="text-label text-[var(--color-fg2)]">
                  Scan the code with hivemind on a phone, or on another computer enter these words (on this network) or the link under Join.
                  You are asked who it is when it does. Until {until}, or once used.
                </p>
              </>
            )}
            <div className="flex flex-wrap gap-2">
              <CopyLink text={shown} />
              {cancel}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2" data-connect-no-page>
          <p className="text-label text-[var(--color-fg2)]">
            A phone's browser opens the page from your network's server over HTTPS, and this network's server does not serve it. An agent here can set that up: it asks you how your devices should reach this computer, then asks you for anything only you can do.
          </p>
          <div className="flex flex-wrap gap-2">
            <StartAgentWith label="Set it up with an agent" work={SET_UP_SERVER} data-serve-with-agent />
            {cancel}
          </div>
        </div>
      )}
    </section>
  );
}

/** The devices asking with the offer, answered here while this page is shown: the toasts would be
 *  behind it. */
function Asking() {
  const [asking, setAsking] = useState<ConnectState["requests"]>([]);
  useRequestsShownHere();
  useEffect(() => {
    void window.hive.connectState().then((s) => setAsking(s.requests), () => {});
    return window.hive.onConnectChanged((s) => setAsking(s.requests));
  }, []);
  if (!asking.length) return null;
  return (
    <section className="flex flex-col gap-2" aria-label="Asking to connect" data-connect-asking>
      {asking.map((r) => (
        <div key={r.id} className="rounded-lg border border-[var(--color-line)] bg-[var(--color-bg2)]">
          <ConnectRequest r={r} answer={(a) => answerRequest(r.id, a)} />
        </div>
      ))}
    </section>
  );
}

function CopyLink({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button variant="outline" data-connect-copy title={text}
      onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
      Copy the link {copied ? <Check /> : <Copy />}
    </Button>
  );
}

/** Who is connected: the devices that are you, then the people in this window's workspace. */
function Connected({ repo, owner, hostedHere }: { repo: string | null; owner: boolean; hostedHere: boolean }) {
  // undefined while it is asked for; null where no app answers (a window in a browser).
  const [devices, setDevices] = useState<PairedDeviceSummary[] | null | undefined>(undefined);
  useEffect(() => {
    const load = () => void window.hive.devices().then((d) => setDevices(d ?? null), () => setDevices(null));
    load();
    return window.hive.onDevicesChanged?.(load);
  }, []);
  return (
    <section className="flex flex-col gap-4" aria-label="Connected" data-connected>
      <h3 className="text-body font-semibold">Connected</h3>
      <div className="flex flex-col gap-1">
        <p className="text-label font-medium text-[var(--color-fg2)]">Your devices</p>
        {devices === undefined ? null : devices === null ? (
          <p className="settings-note">Only the app knows</p>
        ) : devices.length === 0 ? (
          <p className="text-label text-[var(--color-fg3)]" data-devices-none>None yet.</p>
        ) : (
          <>
            <ul className="flex flex-col" data-devices>
              {devices.map((d) => <DeviceRow key={d.device} device={d} />)}
            </ul>
            <p className="settings-note" data-unpair-says>
              Unpair lets that device into nothing on this computer, takes it off your network if this computer let it on, and tells
              the computers of people whose workspaces it joined as you to let it in no more (one that is off hears it once it is
              back). A phone is forgotten by your other devices too. A computer or host stays paired with your other devices until
              you unpair it on each, and keeps your person key: with it, it can still join workspaces and pair devices as you.
            </p>
          </>
        )}
      </div>
      {repo && !owner && <p className="settings-note" data-share-not-owner>The people in this workspace are its owner's to choose.</p>}
      {repo && owner && (
        <div className="flex flex-col gap-1" data-share-access>
          <p className="text-label font-medium text-[var(--color-fg2)]">People in this workspace</p>
          <PeopleList repo={repo} />
          {hostedHere && <Hosting repo={repo} />}
        </div>
      )}
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
      <Button variant="outline" data-unpair onClick={() => void window.hive.unpair(device.device).catch((e: unknown) => setError(messageOf(e)))}>
        Unpair
      </Button>
    </li>
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
  if (!hash) return <p className="text-label text-[var(--color-fg3)]">Working out the page's hash…</p>;
  if ("error" in hash) return <p className="text-label text-[var(--color-err)]" data-pair-page="error">The page's hash could not be worked out: {hash.error}</p>;
  const { served, shipped } = hash;
  const verdict = shipped === null ? "unknown" : served === shipped ? "same" : "other";
  return (
    <p className="text-label text-[var(--color-fg3)]" data-pair-page={verdict} title={served}>
      Page <span className="font-mono">{short(served)}</span>
      {verdict === "same" && ": the page this release of hivemind made."}
      {verdict === "other" && <span className="text-[var(--color-err)]">: not the page this release made (<span className="font-mono">{short(shipped!)}</span>). It is another version, or was changed.</span>}
      {verdict === "unknown" && ": compare it with hive-phone-page.sha256 on the release."}
    </p>
  );
}
