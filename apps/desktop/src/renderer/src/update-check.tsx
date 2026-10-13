/** Whether the app checks for new versions, the one thing it asks outside its network: switched on
 *  About and updates, beside the check itself. */
import { Switch } from "./components/ui/switch";
import { patchSettings, saveSettingsNow, useSettings } from "./settings-store";

export function UpdateCheckSwitch({ onTurnedOn }: { onTurnedOn: () => void }) {
  const { network } = useSettings();
  return (
    <div className="settings-row">
      <div>
        <label htmlFor="update-check">Check for new versions</label>
        <p>Of the app (on GitHub) and of the agents it adds for you (in the plugin catalog), now and then. Off, the app reaches nothing its network does not name until you browse plugins yourself.</p>
      </div>
      <Switch id="update-check" checked={network.updateCheck} aria-label="Check for new versions" data-update-check
        onCheckedChange={(v) => { patchSettings("network.updateCheck", v); if (v) void saveSettingsNow().then(onTurnedOn); }} />
    </div>
  );
}
