/** Where a clicked link opens (`links.web`, `links.files`): a web page in your browser or a Browser
 *  tile, a file in the Code tile or your system's app. */
import type { LinksSettings } from "@hivemind/core/settings-schema";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { patchSettings, useSettings } from "./settings-store";
import { Button } from "./components/ui/button";

const WEB: [LinksSettings["web"], string][] = [["system", "Your browser"], ["tile", "A Browser tile"]];
const FILES: [LinksSettings["files"], string][] = [["code", "The Code tile"], ["system", "Your system's app"]];

export function LinksSetting() {
  const { links } = useSettings();
  return (
    <section className="plugin-section" aria-label="Opening links">
      <h3>Opening links</h3>
      <div className="settings-row">
        <div>
          <label htmlFor="links-web">Web pages open in</label>
          <p>A link clicked in a terminal, a tool or a view, or one an agent opens. A page on this computer, such as localhost, always opens in a Browser tile.</p>
        </div>
        <Select value={links.web} onValueChange={(v) => patchSettings("links.web", v)}>
          <SelectTrigger id="links-web" className="min-w-40" data-links-web><SelectValue /></SelectTrigger>
          <SelectContent>{WEB.map(([v, words]) => <SelectItem key={v} value={v}>{words}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="settings-row">
        <div>
          <label htmlFor="links-files">Files open in</label>
          <p>A path such as <code>src/app.ts:12</code> opens at its line. Pictures open in the Image tile, and only files of your workspaces open at all.</p>
        </div>
        <Select value={links.files} onValueChange={(v) => patchSettings("links.files", v)}>
          <SelectTrigger id="links-files" className="min-w-40" data-links-files><SelectValue /></SelectTrigger>
          <SelectContent>{FILES.map(([v, words]) => <SelectItem key={v} value={v}>{words}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="settings-row" data-links-allowed>
        <div>
          <label>Other kinds of link</label>
          <p>{links.allowedSchemes.length ? "When you click one of these, it goes to your system without asking. Any other kind asks you first. An agent or a view can never open them." : "A kind of link Hivemind does not know, such as vscode: or zoommtg:, asks you first. Choose Always there and it is listed here."}</p>
        </div>
      </div>
      {links.allowedSchemes.map((scheme) => (
        <div key={scheme} className="settings-row" data-links-allowed-scheme={scheme}>
          <span className="flex-1 font-mono">{scheme}:</span>
          <Button variant="outline" size="xs" onClick={() => patchSettings("links.allowedSchemes", links.allowedSchemes.filter((s) => s !== scheme))}>Remove</Button>
        </div>
      ))}
    </section>
  );
}
