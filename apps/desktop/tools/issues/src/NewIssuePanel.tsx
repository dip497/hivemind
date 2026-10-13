/**
 * New issue: title, state, description, labels, assignee and parent. Acceptance criteria are added
 * in the issue panel, which opens on the new issue once it is made (kept out to keep this quick).
 */
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@hivemind/app-ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@hivemind/app-ui";
import { Input } from "@hivemind/app-ui";
import { Label } from "@hivemind/app-ui";
import { Textarea } from "@hivemind/app-ui";
import { useIssueList, write, type Assignee, type IssueState } from "./data";
import type { PanelProps } from "./data";
import { AssigneePicker, LabelPicker, ParentPicker } from "./pickers";

const STATES: { value: IssueState; label: string }[] = [
  { value: "backlog", label: "Backlog" },
  { value: "todo", label: "Todo" },
  { value: "in_progress", label: "In progress" },
  { value: "in_review", label: "In review" },
  { value: "done", label: "Done" },
];

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
function PickerBox({ children }: { children: ReactNode }) {
  return (
    <div className="bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-lg px-2.5 py-1.5 min-h-[38px] flex items-center hm-soft focus-within:border-[var(--color-brand)]">
      {children}
    </div>
  );
}

export function NewIssuePanel({ hm, close, openPanel }: PanelProps) {
  const allIssues = useIssueList() ?? [];
  const [pending, setPending] = useState(false);
  const allLabels = useMemo(() => Array.from(new Set(allIssues.flatMap((i) => i.labels))).sort(), [allIssues]);
  const allAssignees = useMemo(
    () => Array.from(new Set(allIssues.map((i) => i.assignee?.id).filter((x): x is string => !!x))).sort(),
    [allIssues],
  );

  const [title, setTitle] = useState("");
  const [state, setState] = useState<IssueState>("todo");
  const [description, setDescription] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [assignee, setAssignee] = useState<Assignee | null>(null);
  const [parent, setParent] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setPending(true);
    const issue = await write("Creating the issue", hm.issues.create({
      title: title.trim(),
      state,
      description: description.trim() || undefined,
      labels: labels.length ? labels : undefined,
      assignee: assignee ?? undefined,
      parent: parent ?? undefined,
    }));
    setPending(false);
    if (!issue) return;
    close();
    openPanel("issue", { id: issue.id });
  }

  // Only the native <select> still uses this — the shadcn primitives own the text fields.
  const inputCls =
    "w-full bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-lg px-3 py-2 text-body text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-brand)]";

  return (
    <Dialog open onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="sm:max-w-[480px]">
        <form onSubmit={(e) => void submit(e)}>
          <DialogHeader>
            <DialogTitle>New issue</DialogTitle>
            <DialogDescription>
              Lives at <code className="font-mono text-count">.hivemind/issues/&lt;id&gt;.md</code>
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3.5 py-4">
            <Field label="Title">
              <Input
                autoFocus
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Fix flaky CDN cookie tests"
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="State">
                <select value={state} onChange={(e) => setState(e.target.value as IssueState)} className={inputCls}>
                  {STATES.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Assignee">
                <PickerBox>
                  <AssigneePicker value={assignee} allAssignees={allAssignees} onChange={setAssignee} />
                </PickerBox>
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Labels">
                <PickerBox>
                  <LabelPicker value={labels} allLabels={allLabels} onChange={setLabels} />
                </PickerBox>
              </Field>
              <Field label="Parent">
                <PickerBox>
                  <ParentPicker value={parent} candidates={allIssues} onChange={setParent} />
                </PickerBox>
              </Field>
            </div>

            <Field label="Description">
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Markdown. Acceptance criteria can be added after create."
                rows={5}
                font="mono"
                className="resize-y"
              />
            </Field>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim() || pending}>
              {pending ? "Creating…" : "Create issue"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
