/**
 * Join (design §4.2 B): paste an invite link, see whose workspace it is, and ask to join. The host
 * is asked; the answer (a role, or why not) shows here.
 */
import { useEffect, useState } from "react";
import { LogIn } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import { ROLE_LABELS } from "./share-dialog";

const WHY: Record<string, string> = {
  expired: "This invite has expired or was used. Ask for a new one.",
  declined: "The host did not let you in.",
  "not-this-device": "This invite was not made for this device.",
  malformed: "The host did not understand the request.",
};

export function JoinDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<{ workspace: string; host: string } | null>(null);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "asking" } | { kind: "in"; role: string } | { kind: "out"; why: string }>({ kind: "idle" });

  useEffect(() => {
    let live = true;
    void window.hive.joinPreview(text).then((p) => { if (live) setPreview(p); });
    return () => { live = false; };
  }, [text]);

  const join = async () => {
    setState({ kind: "asking" });
    try {
      const reply = await window.hive.join(text);
      setState(reply.ok ? { kind: "in", role: reply.role } : { kind: "out", why: WHY[reply.error] ?? reply.error });
    } catch (e) {
      setState({ kind: "out", why: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { onClose(); setText(""); setState({ kind: "idle" }); } }}>
      <DialogContent className="sm:max-w-[460px]" data-join-dialog>
        <DialogTitle className="flex items-center gap-2"><LogIn size={15} /> Join a shared workspace</DialogTitle>
        <DialogDescription>Paste the invite link someone sent you.</DialogDescription>
        <textarea
          aria-label="Invite link"
          className="min-h-[64px] rounded border border-[var(--color-line)] bg-[var(--color-bg2)] p-2 font-mono text-[11px]"
          value={text}
          onChange={(e) => { setText(e.target.value); setState({ kind: "idle" }); }}
          spellCheck={false}
          data-join-link
        />
        {preview && <p className="text-[12px]" data-join-preview>{preview.workspace} on {preview.host || "their"}{preview.host ? "'s" : ""} machine</p>}
        {state.kind === "in" ? (
          <p className="text-[12px] text-[var(--color-ok)]" role="status" data-join-result="in">You're in: {preview?.workspace} · {ROLE_LABELS[state.role] ?? state.role}</p>
        ) : (
          <Button onClick={() => void join()} disabled={!preview || state.kind === "asking"} data-join-go>
            {state.kind === "asking" ? `Waiting for ${preview?.host || "the host"} to let you in…` : "Join"}
          </Button>
        )}
        {state.kind === "out" && <p className="text-[12px] text-[var(--color-err)]" role="alert" data-join-result="out">{state.why}</p>}
      </DialogContent>
    </Dialog>
  );
}
