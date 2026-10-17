/**
 * Join (design §4.2 B; docs/design/connect-2026-10-13.md §5.4): paste an invite link, another
 * computer's offer to connect, a host's pairing link, or six words, see what it is, and use it. An
 * invite asks the host; an offer asks the person at that computer, while both screens show the
 * same three words; told this computer is theirs, it becomes theirs only once the person here says
 * the words match. Shown inside Open recent, so there is one dialog, never one opening over
 * another closing.
 */
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { ROLE_LABELS } from "./people";
import type { ConnectEntering, JoinPreview } from "../../../shared/ipc";

const WHY: Record<string, string> = {
  expired: "This invite has expired or was used. Ask for a new one.",
  declined: "The host did not let you in.",
  "not-this-device": "This invite was not made for this device.",
  malformed: "The host did not understand the request.",
};

type State =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "in"; role: string; workspace: string; name: string }
  | { kind: "theirs"; name: string }
  | { kind: "out"; why: string };

const messageOf = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));

/** What the button says for what was pasted. */
function goLabel(preview: JoinPreview): string {
  if (preview?.kind === "join") return "Join";
  if (preview?.kind === "pair") return `Pair with ${preview.name}`;
  return "Connect";
}

export function JoinForm({ onOpen }: { onOpen: (workspace: string) => void }) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<JoinPreview>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [entering, setEntering] = useState<ConnectEntering | null>(null);

  useEffect(() => {
    let live = true;
    void window.hive.joinPreview(text).then((p) => { if (live) setPreview(p); });
    return () => { live = false; };
  }, [text]);
  useEffect(() => window.hive.onConnectEntering(setEntering), []);

  const join = async () => {
    const reply = await window.hive.join(text);
    setState(reply.ok ? { kind: "in", role: reply.role, workspace: reply.workspace, name: preview?.kind === "join" ? preview.workspace : "" }
      : reply.error === "not-admitted" ? { kind: "out", why: `This device could not get onto the host's network: ${reply.message ?? "refused"}` }
      : { kind: "out", why: WHY[reply.error] ?? reply.error });
  };
  const connect = async () => {
    const done = await window.hive.connectEnter(text);
    if (done.as === "guest") setState({ kind: "in", role: done.role, workspace: done.workspace.replace(/^hive:\/\//, ""), name: done.names.workspace });
    else setState({ kind: "theirs", name: done.device.name });
  };
  const go = async () => {
    setState({ kind: "asking" });
    try {
      if (preview?.kind === "join") await join();
      else if (preview?.kind === "pair") setState({ kind: "theirs", name: (await window.hive.pairEnter(text)).name });
      else await connect();
    } catch (e) {
      setState({ kind: "out", why: messageOf(e) });
    }
  };

  const waitingOn = preview?.kind === "join" ? preview.host || "the host" : entering?.name ?? (preview && "name" in preview ? preview.name : "the other computer");
  return (
    <div className="flex flex-col gap-2 px-4 pb-4" data-join-dialog>
        <p className="text-label text-[var(--color-fg2)]">Paste the link someone sent you, or type the six words another computer shows.</p>
        <textarea
          aria-label="Invite link or code"
          className="min-h-[64px] rounded border border-[var(--color-line)] bg-[var(--color-bg2)] p-2 font-mono text-count"
          value={text}
          onChange={(e) => { setText(e.target.value); setState({ kind: "idle" }); }}
          spellCheck={false}
          data-join-link
        />
        {preview?.kind === "join" && <p className="text-label" data-join-preview>{preview.workspace} on {preview.host || "their"}{preview.host ? "'s" : ""} machine</p>}
        {(preview?.kind === "connect" || preview?.kind === "pair") && <p className="text-label" data-join-preview>{preview.name}</p>}
        {state.kind === "asking" && entering && (
          <div className="flex flex-col gap-1 rounded-lg border border-[var(--color-line)] p-3" data-connect-words>
            <p className="text-label text-[var(--color-fg2)]">Check that {entering.name} shows these words:</p>
            <p className="text-title" data-connect-words-text>{entering.words.join(" · ")}</p>
          </div>
        )}
        {state.kind === "asking" && entering?.theirs ? (
          <div className="flex flex-col gap-2" data-connect-sure>
            <p className="text-body">
              {entering.name} says this computer is {entering.theirs.name}'s. Do the words match? This computer then acts as {entering.theirs.name},
              and its workspaces become theirs.
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => void window.hive.connectSure(false)} data-connect-sure-no>No</Button>
              <Button variant="outline" onClick={() => void window.hive.connectSure(true)} data-connect-sure-yes>Yes, make this computer {entering.theirs.name}'s</Button>
            </div>
          </div>
        ) : state.kind === "in" ? (
          <>
            <p className="text-label text-[var(--color-ok)]" role="status" data-join-result="in">You're in: {state.name}{state.role ? ` · ${ROLE_LABELS[state.role] ?? state.role}` : ""}</p>
            <Button onClick={() => onOpen(state.workspace)} data-join-open>Open {state.name}</Button>
          </>
        ) : state.kind === "theirs" ? (
          <p className="text-label text-[var(--color-ok)]" role="status" data-join-result="theirs">Connected with {state.name}.</p>
        ) : (
          <Button onClick={() => void go()} disabled={!preview || state.kind === "asking"} data-join-go>
            {state.kind === "asking" ? `Waiting for ${waitingOn} to let you in…` : goLabel(preview)}
          </Button>
        )}
        {state.kind === "out" && <p className="text-label text-[var(--color-err)]" role="alert" data-join-result="out">{state.why}</p>}
    </div>
  );
}
