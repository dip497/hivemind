/**
 * What changed: told once after an update, every version since the one this person last ran,
 * newest first; and from About for this version or the one on offer.
 */
import { useEffect, useState } from "react";
import type { ReleaseNotes } from "../../shared/release-notes";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog";
import { MarkdownPreview } from "./markdown-preview";

/** Show `notes` in the What's new dialog. */
export function showWhatsNew(notes: ReleaseNotes[]): void {
  window.dispatchEvent(new CustomEvent<ReleaseNotes[]>("hivemind:whats-new", { detail: notes }));
}

export function WhatsNew() {
  const [notes, setNotes] = useState<ReleaseNotes[] | null>(null);
  useEffect(() => {
    void window.hive.whatsNew?.().then((n) => { if (n.length) setNotes(n); }, () => {});
    const open = (e: Event) => { const n = (e as CustomEvent<ReleaseNotes[]>).detail; if (n.length) setNotes(n); };
    window.addEventListener("hivemind:whats-new", open);
    return () => window.removeEventListener("hivemind:whats-new", open);
  }, []);
  const newest = notes?.[0];
  return (
    <Dialog open={!!notes} onOpenChange={(open) => { if (!open) setNotes(null); }}>
      <DialogContent className="sm:max-w-[640px]" data-whats-new>
        <DialogTitle>What's new in v{newest?.version}</DialogTitle>
        <DialogDescription>
          {notes && notes.length > 1 ? `And in the ${notes.length - 1} version${notes.length === 2 ? "" : "s"} since you last updated.` : newest?.date}
        </DialogDescription>
        <div className="-mx-1 max-h-[60vh] overflow-y-auto px-1 grid gap-4">
          {notes?.map((n) => (
            <section key={n.version} data-whats-new-version={n.version} className="grid gap-1">
              {notes.length > 1 && <h3 className="text-label font-semibold text-[var(--color-fg)]">v{n.version} <span className="font-normal text-[var(--color-fg3)]">{n.date}</span></h3>}
              <MarkdownPreview source={n.body} className="md-preview text-body" />
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
