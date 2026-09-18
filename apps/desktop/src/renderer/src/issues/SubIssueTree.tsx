import { useState } from "react";
import type { IssueSummary } from "@hivemind/core/types";
import { StateIcon } from "../components/StateMeta";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { MenuItem } from "../components/ui/menu-item";
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
        <MenuItem key={c.id} size="sm" onClick={() => openIssue(c.id, root)} title={`open ${c.id}`}>
          <StateIcon state={c.state} size={11} />
          <span className="font-mono text-[10.5px] text-[var(--color-fg3)] tabular-nums shrink-0">{c.id}</span>
          <span className="text-[12px] text-[var(--color-fg)] truncate">{c.title}</span>
        </MenuItem>
      ))}
      {adding ? (
        <Input
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
          className="mt-0.5"
        />
      ) : (
        <Button variant="ghost" size="xs" className="self-start" onClick={() => setAdding(true)}>
          + sub-issue
        </Button>
      )}
    </div>
  );
}
