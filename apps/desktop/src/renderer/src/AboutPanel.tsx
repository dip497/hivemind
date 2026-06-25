/**
 * Settings / About drawer — a frosted slide-in panel (same `.hm-island` shell
 * as the ThemeCustomizer) that surfaces app identity + self-update state:
 * app name, running version, the GitHub repo, license, and the update status
 * (Up to date / Update available → one-click upgrade-and-restart).
 *
 * Pure presentational — the update check + version live in Canvas (persisted to
 * localStorage), passed in as props. Clicking "Update & restart" calls onUpgrade,
 * which runs the official installer in main and quits the app.
 */
import { ExternalLink, X } from "lucide-react";
import type { UpdateStatus } from "../../shared/ipc";

const REPO_URL = "https://github.com/dip497/hivemind";

export function AboutPanel({
  open,
  onClose,
  version,
  update,
  checking,
  onCheck,
  onUpgrade,
}: {
  open: boolean;
  onClose: () => void;
  /** Running app version (null until main answers getAppVersion). */
  version: string | null;
  /** Latest update check result, or null if it hasn't run / failed silently. */
  update: UpdateStatus | null;
  /** A check is in flight. */
  checking: boolean;
  /** Re-run the update check now. */
  onCheck: () => void;
  /** Run the installer + quit so the new binary takes over. */
  onUpgrade: () => void;
}): React.ReactElement | null {
  if (!open) return null;
  const updateAvailable = update?.updateAvailable === true;

  return (
    <div
      className="hm-drawer-in fixed right-3 top-3 bottom-3 z-50 w-[296px] hm-island rounded-2xl p-4 flex flex-col gap-5 overflow-y-auto pointer-events-auto"
      role="dialog"
      aria-label="About hivemind"
    >
      <header className="flex items-center justify-between">
        <h2 className="text-[13px] font-semibold text-[var(--color-fg)]">Settings &amp; About</h2>
        <button
          onClick={onClose}
          aria-label="close about"
          className="size-6 grid place-items-center rounded text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] cursor-pointer"
        >
          <X size={14} />
        </button>
      </header>

      {/* Identity */}
      <div className="flex flex-col gap-1">
        <div className="text-[18px] font-semibold tracking-tight text-[var(--color-fg)]">hivemind</div>
        <div className="text-[11px] font-mono text-[var(--color-fg3)]">
          {version ? `v${version}` : "version…"}
        </div>
        <p className="text-[11px] leading-snug text-[var(--color-fg3)]">
          A spatial canvas for orchestrating coding agents.
        </p>
      </div>

      {/* Update status */}
      <div className="flex flex-col gap-2">
        <span className="u-eyebrow">Updates</span>
        <div className="rounded-lg border border-[var(--color-line2)] bg-[var(--color-bg3)] px-3 py-2.5 flex flex-col gap-2">
          {updateAvailable ? (
            <>
              <div className="flex items-center gap-2">
                <span className="size-2 rounded-full bg-[var(--color-warn)]" aria-hidden />
                <span className="text-[12px] text-[var(--color-fg)]">
                  Update available{update?.latest ? ` — v${update.latest}` : ""}
                </span>
              </div>
              <button
                onClick={onUpgrade}
                className="self-start text-[11px] px-2.5 py-1.5 rounded-md bg-[var(--color-brand)] text-white hover:opacity-90 cursor-pointer"
                title="Download the latest release and restart"
              >
                Update &amp; restart
              </button>
              <span className="text-[10px] leading-snug text-[var(--color-fg3)]">
                Runs the official installer, then quits — reopen to finish.
              </span>
            </>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span
                  className="size-2 rounded-full"
                  style={{ background: checking ? "var(--color-fg3)" : "var(--color-ok)" }}
                  aria-hidden
                />
                <span className="text-[12px] text-[var(--color-fg2)]">
                  {checking ? "Checking…" : "Up to date"}
                </span>
              </div>
              <button
                onClick={onCheck}
                disabled={checking}
                className="text-[11px] px-2 py-1 rounded border border-[var(--color-line2)] text-[var(--color-fg2)] hover:bg-[var(--color-bg4)] hover:text-[var(--color-fg)] cursor-pointer disabled:opacity-40 disabled:cursor-default"
              >
                Check now
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Links + license */}
      <div className="flex flex-col gap-2">
        <span className="u-eyebrow">Project</span>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-between gap-2 rounded-lg border border-[var(--color-line2)] bg-[var(--color-bg3)] px-3 py-2 text-[12px] text-[var(--color-fg2)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] cursor-pointer"
        >
          <span>GitHub repository</span>
          <ExternalLink size={13} className="text-[var(--color-fg3)]" />
        </a>
        <div className="flex items-center justify-between px-1 text-[11px]">
          <span className="text-[var(--color-fg3)]">License</span>
          <span className="font-mono text-[var(--color-fg2)]">MIT</span>
        </div>
      </div>
    </div>
  );
}
