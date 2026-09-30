/**
 * The host's confirm for a prompt a view wrote: the user reads exactly what the agent will be told,
 * and where, before anything is typed. Focus starts on Cancel, so Enter never sends it.
 */
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../../../components/ui/dialog";
import { Button } from "../../../components/ui/button";

export interface PromptAsk { viewName: string; agent: string; where: string; text: string }

export function PromptDialog({ ask, onChoose }: { ask: PromptAsk | null; onChoose: (send: boolean) => void }) {
  return (
    <Dialog open={!!ask} onOpenChange={(open) => { if (!open) onChoose(false); }}>
      <DialogContent className="sm:max-w-[640px]" data-prompt-dialog>
        <DialogTitle>{ask?.viewName} wants to give {ask?.agent} an instruction</DialogTitle>
        <DialogDescription>{ask?.where}. The agent acts on it with your files and network. Nothing is sent unless you send it.</DialogDescription>
        {ask && (
          <>
            <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius)] border border-[var(--color-line)] p-3 font-mono text-xs">{ask.text}</pre>
            <p className="text-xs text-[var(--color-fg-muted)]">{ask.text.length.toLocaleString()} characters</p>
          </>
        )}
        <DialogFooter>
          <Button variant="ghost" autoFocus onClick={() => onChoose(false)}>Cancel</Button>
          <Button onClick={() => onChoose(true)}>Send</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
