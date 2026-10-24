/**
 * What others ask of this computer, as prompts that stay until answered: to join one of the
 * person's workspaces, or to connect with this app's offer (spec/pairing.md 0.10). Answered at
 * another window or device, a prompt goes; closed, it is no. While a page shows the connect
 * requests itself (Settings → Connect, a dialog the toasts sit behind), their toasts give way to it.
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { ROLE_LABELS } from "./people";
import type { ConnectAnswer, ConnectAsking, ConnectState } from "../../../shared/ipc";

type GuestRole = Extract<ConnectAnswer, { as: "guest" }>["role"];
const GUEST_ROLES: GuestRole[] = ["view", "edit", "terminals"];
const KINDS: Record<ConnectAsking["kind"], string> = { app: "A computer", host: "A host", phone: "A phone" };

const messageOf = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));

/** How the last use of the offer ended, said once. */
function ended(last: NonNullable<ConnectState["last"]>): string {
  if (last.as === "me") return `${last.name} is yours now.`;
  if (last.as === "guest") return `${last.name} was let in.`;
  return `${last.name} said the words did not match. Nothing was kept.`;
}

/** Answer the request `id`; a refusal from main is said. */
export const answerRequest = (id: string, a: ConnectAnswer): void =>
  void window.hive.connectAnswer(id, a).catch((e: unknown) => { toast.error(messageOf(e)); });

/** Pages showing the connect requests now, and who is told when that changes. */
let shownElsewhere = 0;
const told = new Set<() => void>();
const changed = () => { for (const t of told) t(); };

/** The connect requests are shown by the calling page while it is mounted: no toasts meanwhile. */
export function useRequestsShownHere(): void {
  useEffect(() => {
    shownElsewhere++;
    changed();
    return () => { shownElsewhere--; changed(); };
  }, []);
}

/** One device asking to connect: deny first in tab order, so a key pressed by chance answers nothing. */
export function ConnectRequest({ r, answer }: { r: ConnectAsking; answer: (a: ConnectAnswer) => void }) {
  const [role, setRole] = useState<GuestRole>("view");
  return (
    <div className="flex flex-col gap-2 p-3" data-connect-request={r.id}>
      <div className="flex flex-col">
        <p className="text-label font-medium">{r.name} wants to connect</p>
        <p className="text-count text-[var(--color-fg2)]">{KINDS[r.kind]}{r.profile ? ` · says it is ${r.profile.name}` : ""}</p>
      </div>
      <p className="text-title" data-connect-request-words>{r.words.join(" · ")}</p>
      {r.confirming ? (
        <p className="text-label text-[var(--color-fg2)]" role="status" data-connect-request-confirming>
          Waiting for {r.name} to say the words match there.
        </p>
      ) : (
        <>
          <p className="text-label text-[var(--color-fg2)]">Answer only if {r.name} shows these words.</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => answer({ as: "no" })}>Deny</Button>
            {r.guest && (
              <>
                <Select value={role} onValueChange={(v) => setRole(v as GuestRole)}>
                  <SelectTrigger size="sm" aria-label="What they may do" data-connect-request-role><SelectValue /></SelectTrigger>
                  <SelectContent>{GUEST_ROLES.map((g) => <SelectItem key={g} value={g}>{ROLE_LABELS[g]}</SelectItem>)}</SelectContent>
                </Select>
                <Button variant="outline" size="sm" onClick={() => answer({ as: "guest", role })}>Someone else</Button>
              </>
            )}
            {r.me && <Button variant="outline" size="sm" onClick={() => answer({ as: "me" })}>It's me — the words match</Button>}
          </div>
        </>
      )}
    </div>
  );
}

/** Mounted once per window: the prompts for what others ask. */
export function Requests() {
  const joinAsked = useRef(new Map<string, string | number>());
  useEffect(() => {
    const offAsked = window.hive.onJoinRequest((r) => {
      const key = `${r.repo}#${r.req}`;
      const answer = (allow: boolean) => {
        if (!joinAsked.current.delete(key)) return;
        window.hive.answerJoin(r.repo, r.req, allow);
      };
      const who = r.profile.name || "Someone";
      joinAsked.current.set(key, toast(`${who} wants to join ${r.workspace} as ${ROLE_LABELS[r.role] ?? r.role}`, {
        duration: Infinity,
        action: { label: "Allow", onClick: () => answer(true) },
        cancel: { label: "Deny", onClick: () => answer(false) },
        onDismiss: () => answer(false),
        className: "hm-join-request",
      }));
    });
    const offAnswered = window.hive.onJoinAnswered((repo, req) => {
      const key = `${repo}#${req}`;
      const id = joinAsked.current.get(key);
      if (id === undefined) return;
      joinAsked.current.delete(key);
      toast.dismiss(id);
    });
    return () => { offAsked(); offAnswered(); };
  }, []);

  // The connect requests shown, by toast id, and whether closing one still answers it.
  const shown = useRef(new Map<string, boolean>());
  useEffect(() => {
    let lastSeen: string | null = null;
    let latest: ConnectState = { offer: null, requests: [], last: null };
    const show = (state: ConnectState, fresh: boolean) => {
      latest = state;
      const asking = shownElsewhere ? [] : state.requests;
      const now = new Set(asking.map((r) => `connect:${r.id}`));
      for (const id of [...shown.current.keys()]) if (!now.has(id)) { shown.current.delete(id); toast.dismiss(id); }
      for (const r of asking) {
        const id = `connect:${r.id}`;
        const answer = (a: ConnectAnswer) => {
          if (a.as === "no") shown.current.set(id, false);
          answerRequest(r.id, a);
        };
        if (!shown.current.has(id)) shown.current.set(id, true);
        toast.custom(() => <ConnectRequest r={r} answer={answer} />, {
          id, duration: Infinity,
          onDismiss: () => { if (shown.current.get(id)) answer({ as: "no" }); },
        });
      }
      const last = state.last && JSON.stringify(state.last);
      if (fresh && last && last !== lastSeen) toast(ended(state.last!), { className: "hm-connect-ended" });
      lastSeen = last;
    };
    const again = () => show(latest, false);
    told.add(again);
    let live = true;
    void window.hive.connectState().then((s) => { if (live) show(s, false); });
    const off = window.hive.onConnectChanged((s) => show(s, true));
    return () => { live = false; off(); told.delete(again); };
  }, []);
  return null;
}
