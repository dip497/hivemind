/**
 * NewIssueModal — minimal create-issue form.
 *
 * Just title + state + description for v0. Labels/assignee/parent are out
 * of scope here; edit them in IssuePeek after create.
 */
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { useCreateIssue } from "../queries";
import type { IssueState } from "@hivemind/core/types";

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

export function NewIssueModal({ root, open, onOpenChange, onCreated }: Props) {
  const create = useCreateIssue();
  const [title, setTitle] = useState("");
  const [state, setState] = useState<IssueState>("todo");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (open) {
      setTitle("");
      setState("todo");
      setDescription("");
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New issue</DialogTitle>
            <DialogDescription className="text-[var(--color-fg3)]">
              Lives at <code className="font-mono text-[10.5px]">.hivemind/issues/&lt;id&gt;.md</code>
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 py-4">
            <label className="grid gap-1">
              <span className="u-eyebrow">Title</span>
              <input
                autoFocus
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Fix flaky CDN cookie tests"
                className="w-full bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-md px-2.5 py-1.5 text-[13px] text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-1 focus:ring-[var(--color-brand)]"
              />
            </label>

            <label className="grid gap-1">
              <span className="u-eyebrow">State</span>
              <select
                value={state}
                onChange={(e) => setState(e.target.value as IssueState)}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-md px-2.5 py-1.5 text-[13px] text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-1 focus:ring-[var(--color-brand)]"
              >
                {STATES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </label>

            <label className="grid gap-1">
              <span className="u-eyebrow">Description</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Markdown. Acceptance criteria etc. can be added later."
                rows={5}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-md px-2.5 py-1.5 text-[13px] text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-1 focus:ring-[var(--color-brand)] font-mono resize-y"
              />
            </label>
          </div>

          <DialogFooter>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="px-3 py-1.5 text-[12px] text-[var(--color-fg2)] hover:text-[var(--color-fg)] rounded transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!title.trim() || create.isPending}
              className="px-3 py-1.5 text-[12px] font-medium text-white bg-[var(--color-brand)] rounded hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
            >
              {create.isPending ? "Creating…" : "Create issue"}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
