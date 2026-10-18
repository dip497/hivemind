/**
 * The reach chooser (design §13.3 E): what appears the first time something needs a device outside
 * this network (inviting someone elsewhere), and the same choice in Settings → Servers. A way
 * through: the person's own servers, from their network link; one of their devices
 * serving (how); or not now, which keeps this computer on the network it is on.
 */
import { useState } from "react";
import type { NetworkProfile } from "@hivemind/workspace-host/network-profile";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { StartAgentWith } from "../agent-choice";

type Chosen = NetworkProfile & { admission?: string };
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** What an agent here is asked: the outcome, what it needs to know, and what only the person can
 *  do, which it asks for. How devices reach this computer is theirs to choose, so it asks first. */
export const SET_UP_SERVER = `Set up my own Hivemind network server on this computer, so my other devices reach it from anywhere and a phone can open hivemind in its browser.

First ask me how my devices should reach this computer, offering what fits this machine: a VPN such as Tailscale (if it is installed), a domain of mine pointing at a public address, a tunnel, or a port forwarded on my router. Then set it up:

- The server is \`hive-net serve --all --url <the HTTPS address devices use> --data ~/hive-network --phone ~/hive-network/phone\`, kept running in the background and started again after a restart (a user service); \`--bind\` where the HTTPS in front of it reaches it, or \`--domain\` (or \`--cert\` and \`--key\`) for it to serve HTTPS itself. hive-net is beside hive (\`~/.hivemind-app/hive-net\`, or on PATH).
- The phone page: \`mkdir -p ~/hive-network && curl -L https://github.com/dip497/hivemind/releases/latest/download/hive-phone-page.tar.gz | tar -xz -C ~/hive-network\`.
- A phone's browser runs the page only over HTTPS with a trusted certificate: check that https://<address>/phone/manifest.webmanifest answers 200. Use a port nothing else on this machine listens on.
- Put this computer on the network: \`hive network enrol-link --data ~/hive-network --uses 1\`, then \`hive network use <that link>\`, which prints \`admission: enrolled\`.
- Finish only when \`hive network doctor\` says every relay answers; Settings → Servers then shows the new network and checks it by itself.
- What only I can do (a sudo, a DNS record, a setting in an admin console or on my router), ask me and wait. Never type a password.

Then tell me the phone link and how to stop the server.`;

export function ReachChooser({ onChosen, onCancel, current }: { onChosen: (net: Chosen) => void; onCancel?: () => void; current?: NetworkProfile | null }) {
  const [link, setLink] = useState("");
  const [serving, setServing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const use = async (given: string) => {
    setError(null);
    try { onChosen(await window.hive.useNetwork(given)); } catch (e) { setError(messageOf(e)); }
  };
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md border border-[var(--color-line)] p-3 text-label" data-reach-chooser>
      <p className="text-[var(--color-fg2)]">To reach devices outside this network, hivemind needs a way through. Choose one:</p>
      {current?.builtin !== "local" && (
        <Button variant="ghost" className="justify-start" onClick={() => void use("local")} data-use-network="local">
          Local network — no servers; only devices here
        </Button>
      )}
      <div className="flex flex-col gap-1">
        <span>Use my own servers — paste the network link from its admin:</span>
        <div className="flex gap-2">
          <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="hivemind://network/…" className="flex-1" data-network-link />
          <Button onClick={() => void use(link)} disabled={!link.trim()} data-use-network="link">Use</Button>
        </div>
      </div>
      <Button variant="ghost" className="justify-start" onClick={() => setServing((s) => !s)} data-reach-serve>
        Serve from one of my devices
      </Button>
      {serving && (
        <div className="flex flex-col items-start gap-2 rounded bg-[var(--color-bg3)] p-2 text-[var(--color-fg2)]" data-reach-serve-how>
          <p>An agent here sets up a server on this computer: it asks you how your devices should reach it, then asks you for anything only you can do.</p>
          <StartAgentWith label="Set it up with an agent" work={SET_UP_SERVER} data-serve-with-agent />
        </div>
      )}
      {onCancel && (
        <Button variant="ghost" className="justify-start" onClick={onCancel} data-reach-not-now>
          Not now — stay on this network
        </Button>
      )}
      {error && <p className="text-[var(--color-err)]" role="alert">{error}</p>}
    </div>
  );
}
