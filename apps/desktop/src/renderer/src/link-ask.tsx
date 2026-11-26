/**
 * Asks the person before a kind of link the app does not know (`vscode:`, `zoommtg:`) goes to their
 * system: once, always for that kind (`links.allowedSchemes`), or not at all. Only a person's own
 * click asks; an agent or a view is refused instead.
 */
import { useSyncExternalStore } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./components/ui/dialog";
import { Button } from "./components/ui/button";

export type LinkAnswer = "once" | "always" | "cancel";
interface Asking { scheme: string; url: string; answer(a: LinkAnswer): void }

let asking: Asking | null = null;
const listeners = new Set<() => void>();
const tell = () => { for (const l of listeners) l(); };

/** Ask about one link; a second ask while one is open cancels the first. */
export function askToOpen(scheme: string, url: string): Promise<LinkAnswer> {
  asking?.answer("cancel");
  return new Promise((resolve) => {
    const mine: Asking = { scheme, url, answer: (a) => { if (asking === mine) { asking = null; tell(); } resolve(a); } };
    asking = mine;
    tell();
  });
}

export function LinkAskDialog() {
  const ask = useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => asking);
  return (
    <Dialog open={!!ask} onOpenChange={(open) => { if (!open) ask?.answer("cancel"); }}>
      <DialogContent className="sm:max-w-[460px]" data-link-ask={ask?.scheme}>
        <DialogTitle>Open {ask?.scheme} links with your system?</DialogTitle>
        <DialogDescription className="break-all">{ask?.url}</DialogDescription>
        <DialogFooter>
          <Button variant="ghost" autoFocus onClick={() => ask?.answer("cancel")} data-link-ask-cancel>Cancel</Button>
          <Button variant="outline" onClick={() => ask?.answer("always")} data-link-ask-always>Always for {ask?.scheme}</Button>
          <Button onClick={() => ask?.answer("once")} data-link-ask-once>Allow once</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
