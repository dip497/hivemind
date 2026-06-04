/** ⌘K palette — fuzzy search over real issues + canvas actions. No stubs.
 *  Linear/Raycast-style: top-anchored, app-themed, keyboard-hint footer. */
import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Bot,
  CornerDownLeft,
  Folder,
  FolderOpen,
  FolderTree,
  Frame as FrameIcon,
  GitCommit,
  LayoutGrid,
  Plus,
  Sparkles,
  Terminal as TerminalIcon,
} from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "./ui/command";
import { StateIcon } from "./StateMeta";
import { useIssues } from "../queries";

interface Props {
  root: string | null;
  repoPath: string | null;
  /** Recent project paths (most-recent first). */
  recents?: string[];
  onPickFolder?: () => void | Promise<void>;
  onOpenRecent?: (path: string) => void;
  /** True when launched in a folder with no .hivemind/ — surface "Initialize workspace here…". */
  canInit?: boolean;
  onInit?: () => void;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded bg-[var(--color-bg)] border border-[var(--color-line2)] text-[10px] font-mono text-[var(--color-fg2)]">
      {children}
    </kbd>
  );
}

export function CommandPalette({ root, repoPath, recents = [], onPickFolder, onOpenRecent, canInit, onInit }: Props) {
  const [open, setOpen] = useState(false);
  const { data: issues = [] } = useIssues(root);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen((o) => !o);
    window.addEventListener("keydown", onKey);
    // Bridge from main-process before-input-event (Ctrl+K is eaten by xterm
    // before it reaches the DOM, so main forwards as IPC → App re-emits this).
    window.addEventListener("hivemind:toggle-palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("hivemind:toggle-palette", onOpen);
    };
  }, []);

  const close = () => setOpen(false);
  const fire = (name: string, detail?: unknown) => {
    window.dispatchEvent(new CustomEvent(name, detail !== undefined ? { detail } : undefined));
    close();
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        {/* Soft overlay — no backdrop-blur (perf): the canvas behind a modal is
            static, but blur still costs a full-region rasterize on open/close. */}
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0" />
        <Dialog.Content
          aria-label="Command palette"
          // Top-anchored (Raycast/Linear), wider, app theme tokens — not the
          // generic dead-center shadcn modal.
          className="fixed left-1/2 top-[13vh] z-50 w-[min(640px,92vw)] -translate-x-1/2 overflow-hidden rounded-xl border border-[var(--color-line2)] bg-[var(--color-bg2)] shadow-[0_24px_70px_rgba(0,0,0,0.6)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-top-2"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          {/* key={open} remounts cmdk on each open → empty search + first item
              pre-selected, instead of stale state from the last invocation. */}
          <Command
            key={open ? "open" : "closed"}
            className="bg-transparent [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.12em] [&_[cmdk-group-heading]]:text-[var(--color-fg3)]"
          >
            <CommandInput placeholder="Search issues or run a command…" className="text-[13px]" />
            <CommandList className="max-h-[54vh] p-1.5">
              <CommandEmpty>
                <span className="text-[var(--color-fg3)]">No matches</span>
              </CommandEmpty>

              <CommandGroup heading="Workspace">
                {canInit && onInit && (
                  <CommandItem
                    value="initialize workspace here init hivemind setup"
                    onSelect={() => {
                      close();
                      onInit();
                    }}
                  >
                    <Sparkles />
                    <span>Initialize workspace here…</span>
                  </CommandItem>
                )}
                <CommandItem
                  value="open folder workspace project"
                  onSelect={() => {
                    close();
                    void onPickFolder?.();
                  }}
                >
                  <FolderOpen />
                  <span>Open folder…</span>
                  <CommandShortcut>⌃O</CommandShortcut>
                </CommandItem>
                {recents.map((p) => (
                  <CommandItem
                    key={`recent-${p}`}
                    value={`recent ${p}`}
                    onSelect={() => {
                      onOpenRecent?.(p);
                      close();
                    }}
                  >
                    <Folder />
                    <span className="truncate">{p.split("/").slice(-1)[0]}</span>
                    <span className="ml-auto truncate max-w-[55%] text-[10.5px] text-[var(--color-fg3)] font-mono">
                      {p}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>

              <CommandGroup heading="Create">
                <CommandItem value="new issue create" onSelect={() => fire("hivemind:new-issue")}>
                  <Plus />
                  <span>New issue</span>
                  <CommandShortcut>⌘N</CommandShortcut>
                </CommandItem>
                <CommandItem value="claude agent talk spawn" onSelect={() => fire("hivemind:spawn-claude")}>
                  <Bot />
                  <span>Talk to Claude</span>
                  <CommandShortcut>⌘\</CommandShortcut>
                </CommandItem>
                <CommandItem value="frame group add" onSelect={() => fire("hivemind:add-frame")}>
                  <FrameIcon />
                  <span>Add frame</span>
                  <CommandShortcut>F</CommandShortcut>
                </CommandItem>
              </CommandGroup>

              <CommandGroup heading="Toggle panels">
                <CommandItem value="terminal shell toggle" onSelect={() => fire("hivemind:canvas-toggle", "shell")}>
                  <TerminalIcon />
                  <span>Terminal</span>
                  <CommandShortcut>⌘T</CommandShortcut>
                </CommandItem>
                <CommandItem
                  value="file tree explorer toggle"
                  disabled={!repoPath}
                  onSelect={() => repoPath && fire("hivemind:canvas-toggle", "tree")}
                >
                  <FolderTree />
                  <span>Explorer</span>
                  <CommandShortcut>⌘B</CommandShortcut>
                </CommandItem>
                <CommandItem
                  value="diff git changes toggle"
                  disabled={!repoPath}
                  onSelect={() => repoPath && fire("hivemind:canvas-toggle", "diff")}
                >
                  <GitCommit />
                  <span>Diff</span>
                  <CommandShortcut>⌘D</CommandShortcut>
                </CommandItem>
                <CommandItem
                  value="issues board tracker toggle"
                  disabled={!repoPath}
                  onSelect={() => repoPath && fire("hivemind:canvas-toggle", "issues")}
                >
                  <LayoutGrid />
                  <span>Issues board</span>
                  <CommandShortcut>6</CommandShortcut>
                </CommandItem>
              </CommandGroup>

              {issues.length > 0 && (
                <CommandGroup heading="Issues">
                  {issues.slice(0, 25).map((i) => (
                    <CommandItem
                      key={i.id}
                      value={`${i.id} ${i.title} ${i.labels.join(" ")}`}
                      onSelect={() => fire("hivemind:open-issue", i.id)}
                    >
                      <StateIcon state={i.state} size={14} />
                      <span className="font-mono text-[10.5px] text-[var(--color-fg2)] tabular-nums mr-0.5">
                        {i.id}
                      </span>
                      <span className="truncate">{i.title}</span>
                      <CommandShortcut>
                        <CornerDownLeft className="!size-3" />
                      </CommandShortcut>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>

            {/* Keyboard-hint footer (Raycast/Linear) — orients new users. */}
            <div className="flex items-center gap-3 px-3 py-2 border-t border-[var(--color-line)] text-[10.5px] text-[var(--color-fg3)]">
              <span className="inline-flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
              <span className="inline-flex items-center gap-1"><Kbd>↵</Kbd> open</span>
              <span className="inline-flex items-center gap-1"><Kbd>esc</Kbd> close</span>
              <span className="ml-auto inline-flex items-center gap-1"><Kbd>⌘K</Kbd> toggle</span>
            </div>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
