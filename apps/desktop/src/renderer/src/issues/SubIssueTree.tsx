import { useState } from "react";
import type { IssueSummary } from "@hivemind/core/types";
import { StateIcon } from "../components/StateMeta";
import { useCreateIssue } from "../queries";
import { openIssue } from "./IssueCard";

/** The direct children of an issue (dotted-ID hierarchy) + an inline "add". */
export function SubIssueTree({
  root,
  parentId,
  items,
}: {
  root: string;
  parentId: string;
  items: IssueSummary[];
}) {
  const create = useCreateIssue();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const submit = () => {
    const t = title.trim();
    if (t) create.mutate({ root, opts: { title: t, parent: parentId } });
    setTitle("");
    setAdding(false);
  };
  return (
    <div className="flex flex-col gap-0.5">
      {items.map((c) => (
        <button
          key={c.id}
          onClick={() => openIssue(c.id, root)}
          className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-[var(--color-bg3)] text-left cursor-pointer"
          title={`open ${c.id}`}
        >
          <StateIcon state={c.state} size={11} />
          <span className="font-mono text-[10.5px] text-[var(--color-fg3)] tabular-nums shrink-0">{c.id}</span>
          <span className="text-[12px] text-[var(--color-fg)] truncate">{c.title}</span>
        </button>
      ))}
      {adding ? (
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") {
              setTitle("");
              setAdding(false);
            }
          }}
          onBlur={submit}
          placeholder="sub-issue title…"
          className="mt-0.5 px-2 py-1 text-[12px] bg-[var(--color-bg)] border border-[var(--color-line2)] rounded outline-none focus:border-[var(--color-brand)] text-[var(--color-fg)] placeholder:text-[var(--color-fg3)]"
        />
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="text-left px-1.5 py-1 text-[11.5px] text-[var(--color-fg2)] hover:text-[var(--color-fg)] cursor-pointer"
        >
          + sub-issue
        </button>
      )}
    </div>
  );
}
