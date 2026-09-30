/**
 * The reach chooser (design §13.3 E): what appears the first time something needs a device outside
 * this network (inviting someone elsewhere), and the same choice in Settings → Network. A way
 * through: hivemind's servers; the person's own, from their network link; one of their devices
 * serving (how); or not now, which keeps this computer on the network it is on.
 */
import { useState } from "react";
import type { NetworkProfile } from "@hivemind/workspace-host/network-profile";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

type Chosen = NetworkProfile & { admission?: string };
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

export function ReachChooser({ onChosen, onCancel, current }: { onChosen: (net: Chosen) => void; onCancel?: () => void; current?: NetworkProfile | null }) {
  const [link, setLink] = useState("");
  const [serving, setServing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const use = async (given: string) => {
    setError(null);
    try { onChosen(await window.hive.useNetwork(given)); } catch (e) { setError(messageOf(e)); }
  };
  return (
    <div className="flex flex-col gap-2 rounded-md border border-[var(--color-line)] p-3 text-[12px]" data-reach-chooser>
      <p className="text-[var(--color-fg2)]">To reach devices outside this network, hivemind needs a way through. Choose one:</p>
      {current?.builtin !== "local" && (
        <Button size="sm" variant="ghost" className="justify-start" onClick={() => void use("local")} data-use-network="local">
          Local network — no servers; only devices here
        </Button>
      )}
      <Button size="sm" variant="ghost" className="h-auto justify-start whitespace-normal text-left" disabled={current?.builtin === "hosted"} onClick={() => void use("hosted")} data-use-network="hosted">
        <span className="py-1.5">Use hivemind's servers — free, nothing to set up. They forward encrypted traffic and help devices find each other; they never see your work.</span>
      </Button>
      <div className="flex flex-col gap-1">
        <span>Use my own servers — paste the network link from its admin:</span>
        <div className="flex gap-2">
          <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="hivemind://network/…" className="flex-1" data-network-link />
          <Button size="sm" onClick={() => void use(link)} disabled={!link.trim()} data-use-network="link">Use</Button>
        </div>
      </div>
      <Button size="sm" variant="ghost" className="justify-start" onClick={() => setServing((s) => !s)} data-reach-serve>
        Serve from one of my devices
      </Button>
      {serving && (
        <p className="rounded bg-[var(--color-bg3)] p-2 text-[var(--color-fg2)]" data-reach-serve-how>
          On a machine the others can reach (a public address, a forwarded port or a VPN), run{" "}
          <code className="font-mono">hive-net serve --relay --access --admin-id &lt;your key&gt; --data ~/hive-network</code>, sign a
          profile naming it with <code className="font-mono">hive-net profile sign</code>, and paste its link above.
        </p>
      )}
      {onCancel && (
        <Button size="sm" variant="ghost" className="justify-start" onClick={onCancel} data-reach-not-now>
          Not now — stay on this network
        </Button>
      )}
      {error && <p className="text-[var(--color-err)]" role="alert">{error}</p>}
    </div>
  );
}
