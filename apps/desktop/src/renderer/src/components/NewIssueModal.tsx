/**
 * NewIssueModal — create an issue with the full metadata the backend supports:
 * title, state, description, labels, assignee, parent. Acceptance criteria are
 * still added in the peek after create (kept out to keep this form quick).
 */
import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { useCreateIssue, useIssues } from "../queries";
import type { Assignee, IssueState } from "@hivemind/core/types";
import { AssigneePicker, LabelPicker, ParentPicker } from "../issues/pickers";

interface Props {
  root: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional: set on submit so the new issue's peek opens immediately. */
  onCreated?: (id: string) => void;
}

const STATES: { value: IssueState; label: string }[] = [
  { value: "backlog", label: "Backlog" },
  { value: "todo", label: "Todo" },
  { value: "in_progress", label: "In progress" },
  { value: "in_review", label: "In review" },
  { value: "done", label: "Done" },
];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <span className="u-eyebrow">{label}</span>
      {children}
    </div>
  );
}
function PickerBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-lg px-2.5 py-1.5 min-h-[38px] flex items-center hm-soft focus-within:border-[var(--color-brand)]">
      {children}
    </div>
  );
}

export function NewIssueModal({ root, open, onOpenChange, onCreated }: Props) {
  const create = useCreateIssue();
  const { data: allIssues = [] } = useIssues(root);
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

  useEffect(() => {
    if (open) {
      setTitle("");
      setState("todo");
      setDescription("");
      setLabels([]);
      setAssignee(null);
      setParent(null);
    }
  }, [open]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!root || !title.trim()) return;
    create.mutate(
      {
        root,
        opts: {
          title: title.trim(),
          state,
          description: description.trim() || undefined,
          labels: labels.length ? labels : undefined,
          assignee: assignee ?? undefined,
          parent: parent ?? undefined,
        },
      },
      {
        onSuccess: (issue) => {
          onOpenChange(false);
          if (onCreated) onCreated(issue.id);
        },
      },
    );
  }

  const inputCls =
    "w-full bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-lg px-3 py-2 text-[13px] text-[var(--color-fg)] placeholder:text-[var(--color-fg3)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-2 focus:ring-[var(--color-brand)]/30 hm-soft";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle className="text-[16px] font-semibold text-[var(--color-fg)]">New issue</DialogTitle>
            <DialogDescription className="text-[var(--color-fg3)] text-[12px]">
              Lives at <code className="font-mono text-[10.5px]">.hivemind/issues/&lt;id&gt;.md</code>
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3.5 py-4">
            <Field label="Title">
              <input
                autoFocus
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Fix flaky CDN cookie tests"
                className={inputCls}
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
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Markdown. Acceptance criteria can be added after create."
                rows={5}
                className={`${inputCls} font-mono resize-y`}
              />
            </Field>
          </div>

          <DialogFooter className="gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="px-3.5 py-2 text-[12px] font-medium text-[var(--color-fg2)] hover:text-[var(--color-fg)] rounded-lg hover:bg-[var(--color-bg3)] hm-soft"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!title.trim() || create.isPending}
              className="px-3.5 py-2 text-[12px] font-semibold text-white bg-[var(--color-brand)] rounded-lg hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed hm-soft"
            >
              {create.isPending ? "Creating…" : "Create issue"}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
