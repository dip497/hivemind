/** What quitting does while agents or terminals run here: asked each time, or chosen once with the
 *  quit dialog's "Don't ask again" and changed back here. */
import type { QuitChoice } from "@hivemind/core/settings-schema";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { patchSettings, useSettings } from "./settings-store";

const CHOICES: [QuitChoice, string][] = [["ask", "Ask each time"], ["keep-running", "Keep them running"], ["stop-everything", "Stop everything"]];

export function QuitSetting() {
  const { quit } = useSettings();
  if (!window.hive.quit) return null;
  return (
    <div className="settings-row">
      <div>
        <label htmlFor="when-quitting">When you quit while agents run</label>
        <p>Keep them running in the background, or stop everything on this computer; what stops comes back where it was when Hivemind starts again.</p>
      </div>
      <Select value={quit.whenRunning} onValueChange={(v) => patchSettings("quit.whenRunning", v as QuitChoice)}>
        <SelectTrigger id="when-quitting" className="min-w-40" data-when-quitting><SelectValue /></SelectTrigger>
        <SelectContent>{CHOICES.map(([v, words]) => <SelectItem key={v} value={v}>{words}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
}
