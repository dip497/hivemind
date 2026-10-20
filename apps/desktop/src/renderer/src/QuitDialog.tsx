/**
 * Quitting while agents or terminals run here asks whether they keep running in the background or
 * stop with the app. Focus starts on Keep them running, so Enter never ends a session.
 */
import { useEffect, useState } from "react";
import type { QuitAnswer, QuitQuestion } from "../../shared/ipc";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./components/ui/dialog";
import { Button } from "./components/ui/button";

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** What still runs, as the dialog says it. */
function quitMessage(q: QuitQuestion): string {
  const what = q.uncounted ? "Agents or terminals may still be running: the background process did not say." : q.agents ? `${count(q.agents, "agent")} ${q.agents === 1 ? "is" : "are"} still working.` : `${count(q.terminals, "terminal")} ${q.terminals === 1 ? "is" : "are"} still running.`;
  const elsewhere = !q.elsewhere ? "" : q.elsewhere === 1 ? " The agent on another machine keeps running either way." : ` The ${q.elsewhere} agents on other machines keep running either way.`;
  return `${what} Keep them running in the background, or stop everything on this computer; each comes back where it was when Hivemind starts again.${elsewhere}`;
}

export function QuitDialog() {
  const [ask, setAsk] = useState<QuitQuestion | null>(null);
  const [remember, setRemember] = useState(false);
  useEffect(() => window.hive.onQuitAsk?.((q) => { setRemember(false); setAsk(q); }), []);
  const choose = (choice: QuitAnswer["choice"]) => {
    setAsk(null);
    void window.hive.answerQuit?.({ choice, remember: remember && choice !== "cancel" });
  };
  return (
    <Dialog open={!!ask} onOpenChange={(open) => { if (!open) choose("cancel"); }}>
      <DialogContent className="sm:max-w-[460px]" data-quit-ask>
        <DialogTitle>Quit Hivemind?</DialogTitle>
        <DialogDescription>{ask ? quitMessage(ask) : ""}</DialogDescription>
        <label className="flex items-center gap-2 text-label text-[var(--color-fg2)] cursor-pointer">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} data-quit-remember />
          Don't ask again
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={() => choose("cancel")} data-quit-cancel>Cancel</Button>
          <Button variant="outline" onClick={() => choose("stop-everything")} data-quit-stop>Stop everything</Button>
          <Button autoFocus onClick={() => choose("keep-running")} data-quit-keep>Keep them running</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
