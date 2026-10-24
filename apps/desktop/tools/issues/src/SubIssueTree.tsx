import { useState } from "react";
import { useIssuesPlugin, useOpenIssue, write, type IssueSummary } from "./data";
import { IssueStatusIcon } from "./IssueCard";
import { Button } from "@hivemind/app-ui";
import { Input } from "@hivemind/app-ui";
import { MenuItem } from "@hivemind/app-ui";

/** The direct children of an issue (dotted-ID hierarchy) + an inline "add". */
export function SubIssueTree({
  parentId,
  items,
}: {
  parentId: string;
  items: IssueSummary[];
}) {
  const { hm } = useIssuesPlugin();
  const openIssue = useOpenIssue();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const submit = () => {
    const t = title.trim();
    if (t) void write("Adding a sub-issue", hm.issues.create({ title: t, parent: parentId }));
    setTitle("");
    setAdding(false);
  };
  return (
    <div className="flex flex-col gap-0.5">
      {items.map((c) => (
        <MenuItem key={c.id} size="sm" onClick={() => openIssue(c.id)} title={`open ${c.id}`}>
          <IssueStatusIcon issue={c} size={11} />
          <span className="font-mono text-count text-[var(--color-fg3)] tabular-nums shrink-0">{c.id}</span>
          <span className="text-label text-[var(--color-fg)] truncate">{c.title}</span>
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
