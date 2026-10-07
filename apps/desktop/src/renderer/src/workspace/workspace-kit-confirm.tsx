/**
 * Where the person reads what a plugin wants to tell an agent, and sends or cancels it (the
 * workspace kit's confirm; workspace-kit.tsx asks).
 */
import { useSyncExternalStore } from "react";
import { Button } from "../components/ui/button";
import { kitAsk } from "./workspace-kit";

export function KitConfirm() {
  const ask = useSyncExternalStore(kitAsk.subscribe, kitAsk.now);
  if (!ask) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label={`${ask.from} wants to tell an agent`} data-kit-confirm
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="hm-island flex w-full max-w-[460px] flex-col gap-3 rounded-xl p-4 text-[13px]">
        <p><b>{ask.from}</b> wants to send this. {ask.where}:</p>
        <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap rounded-md bg-[var(--color-bg3)] p-3 font-mono text-[12px]">{ask.text}</pre>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => ask.answer(false)}>Cancel</Button>
          <Button size="sm" onClick={() => ask.answer(true)} autoFocus>Send</Button>
        </div>
      </div>
    </div>
  );
}
