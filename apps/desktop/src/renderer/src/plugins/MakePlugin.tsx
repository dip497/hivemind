/**
 * Make your own plugin: say what it should do, then copy the prompt for an agent you run anywhere,
 * or hand it to an agent here. The prompt is short on purpose: `hive <kind>s new` writes the whole
 * brief (PROMPT.md) beside the starter, so what an agent reads always matches the app it runs on.
 */
import { useState } from "react";
import { Check, Copy, Sparkles } from "../components/icons";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";

export type MakeKind = "widget" | "tool" | "view";

const KINDS: Array<[MakeKind, string, string]> = [
  ["widget", "Widget", "A box on the board, in every view: a counter, a status, a checklist an agent keeps."],
  ["tool", "Tool", "A kind of tile with its frame's folder and programs: pull requests, CI runs, a log viewer."],
  ["view", "View", "A whole way to see the workspace: a kanban of agents, a map, an office."],
];
const NOUN: Record<MakeKind, string> = { widget: "widget", tool: "tool plugin", view: "view" };

/** What an agent is asked: the idea, and where the rest of what it needs is. */
export function makePluginPrompt(kind: MakeKind, idea: string): string {
  const want = idea.trim();
  return `Build me a Hivemind ${NOUN[kind]}${want ? `: ${want}` : "."}

1. Start it with \`hive plugins new ${kind} <name>\` in ~/hivemind-plugins (make the folder if it is not there), with a short lowercase name that says what it is.
2. Read PROMPT.md in the folder that makes: the whole contract, and how to install it, show it and check it.
3. Build it, install it, show it with \`hive ctl plugin open\`, and check it through its own commands (\`hive ctl plugin call\`) until it does what I asked.
4. Tell me what you made and how to use it.`;
}

export function MakePluginDialog({ kind: initial, onStart, onClose }: { kind: MakeKind; onStart: (prompt: string) => void; onClose: () => void }) {
  const [kind, setKind] = useState<MakeKind>(initial);
  const [idea, setIdea] = useState("");
  const [copied, setCopied] = useState(false);
  const prompt = makePluginPrompt(kind, idea);
  const copy = () => void navigator.clipboard.writeText(prompt).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, () => toast.error("Could not reach the clipboard."));
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-[480px]" data-make-plugin>
        <DialogTitle><span className="flex items-center gap-2"><Sparkles size={15} /> Make your own</span></DialogTitle>
        <DialogDescription>An agent builds it, installs it and checks it works. Say what it should do.</DialogDescription>
        <div role="radiogroup" aria-label="What to make" className="grid grid-cols-3 gap-1.5">
          {KINDS.map(([id, label, hint]) => (
            <button key={id} type="button" role="radio" aria-checked={kind === id} data-make-kind={id} title={hint} onClick={() => setKind(id)}
              className={`rounded-md border px-2 py-1.5 text-left text-label ${kind === id ? "border-[var(--color-accent)] bg-[var(--color-bg3)] text-[var(--color-fg)]" : "border-[var(--color-line)] text-[var(--color-fg2)] hover:bg-[var(--color-bg3)]/60"}`}>
              <span className="font-medium">{label}</span>
            </button>
          ))}
        </div>
        <p className="text-label text-[var(--color-fg3)]">{KINDS.find(([id]) => id === kind)![2]}</p>
        <Textarea autoFocus value={idea} onChange={(e) => setIdea(e.target.value)} rows={3} aria-label="What should it do?" data-make-idea
          placeholder={kind === "widget" ? "Shows how many agents are working, and turns red when one is blocked" : kind === "tool" ? "Lists the open issues assigned to me, and hands one to an agent" : "A kanban of agents: waiting, working, done"} />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={copy} data-make-copy>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy prompt"}</Button>
          <Button onClick={() => { onClose(); onStart(prompt); }} data-make-start><Sparkles />Start an agent</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
