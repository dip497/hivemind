/** Settings: keep git's commit-graph with Bloom filters in the repos history is shown for, which
 *  makes a file's history and the log several times faster on a large repo
 *  (docs/design/git-history-2026-11-02.md §5.2). On by default; what it writes is said here. */
import { Switch } from "./components/ui/switch";
import { patchSettings, useSettings } from "./settings-store";

export function CommitGraphSetting() {
  const { code } = useSettings();
  return (
    <div className="settings-row">
      <div>
        <label htmlFor="commit-graph">Speed up history</label>
        <p>Keeps git's commit-graph, with filters for each path, in the repositories you look at history in (<code>.git/objects/info/commit-graphs</code>). It is what <code>git gc</code> writes, written sooner, and makes a file's history and the log several times faster on a large repository.</p>
      </div>
      <Switch id="commit-graph" checked={code.commitGraph} aria-label="Speed up history" data-commit-graph
        onCheckedChange={(v) => patchSettings("code.commitGraph", v)} />
    </div>
  );
}
