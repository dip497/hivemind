/**
 * Go to file (Ctrl+P / ⌘P): a file by a fuzzy name, what you open often and lately first
 * (`code.findFiles`, fff on the host). The list and its keys are cmdk's (the command menu the app's
 * design system already draws its dialogs with); the ranking is fff's, so cmdk's own filter is off.
 * A pick is told to fff (`code.picked`), which ranks that file higher for the same query next time.
 */
import { Command } from "cmdk";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";

export function QuickOpen({ repoPath, open, onOpenChange, onPick }: {
  repoPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const q = useQuery({
    queryKey: ["code:findFiles", repoPath, query],
    queryFn: () => window.hive.codeFindFiles(repoPath, query, 50),
    enabled: open,
    placeholderData: (prev) => prev,
    staleTime: 2_000,
  });
  const pick = (path: string) => {
    onOpenChange(false);
    void window.hive.codePicked(repoPath, query, path).catch(() => {});
    onPick(path);
    setQuery("");
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent padding="none" closeButton={false} className="max-w-xl overflow-hidden" data-quick-open>
        <DialogTitle className="sr-only">Go to file</DialogTitle>
        <Command shouldFilter={false} label="Go to file" className="flex flex-col">
          <Command.Input value={query} onValueChange={setQuery} placeholder="Go to file…" autoFocus
            className="h-10 px-3 bg-transparent border-b border-[var(--color-line)] text-row text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg3)]" />
          <Command.List className="max-h-[50vh] overflow-y-auto p-1">
            {!q.isFetching && (q.data?.files.length ?? 0) === 0 && (
              <Command.Empty className="px-3 py-2 text-label text-[var(--color-fg3)]">no file matches</Command.Empty>
            )}
            {q.data?.files.map((f) => {
              const slash = f.path.lastIndexOf("/");
              return (
                <Command.Item key={f.path} value={f.path} onSelect={() => pick(f.path)} data-quick-open-file={f.path}
                  className="flex items-center gap-2 px-2 h-7 rounded-md cursor-pointer text-label data-[selected=true]:bg-[var(--color-bg4)]">
                  <span className="text-[var(--color-fg)]">{f.path.slice(slash + 1)}</span>
                  <span className="truncate text-count text-[var(--color-fg3)]">{f.path.slice(0, Math.max(0, slash))}</span>
                  {f.git && <span className="ml-auto text-chip uppercase text-[var(--color-fg2)]">{f.git[0]}</span>}
                </Command.Item>
              );
            })}
          </Command.List>
          {q.data?.engine === "git" && <div className="px-3 py-1 border-t border-[var(--color-line)] text-count text-[var(--color-fg3)]">from git's file list (fff is not available here)</div>}
        </Command>
      </DialogContent>
    </Dialog>
  );
}
