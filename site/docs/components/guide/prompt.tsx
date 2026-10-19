'use client';
import { Check, ChevronRight, Copy, Sparkles } from 'lucide-react';
import { useState } from 'react';

const CURSOR_ICON = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-3.5">
    <path d="M11.925 24l10.425-6-10.425-6L1.5 18l10.425 6z" opacity=".6" />
    <path d="M22.35 18V6L11.925 0v12l10.425 6z" opacity=".8" />
    <path d="M11.925 0L1.5 6v12l10.425-6V0z" />
  </svg>
);

const button =
  'inline-flex items-center gap-1.5 rounded-md border bg-fd-background px-2.5 py-1 text-xs font-medium text-fd-foreground transition-colors hover:bg-fd-accent [&_svg]:size-3.5';

/** Instructions a person pastes into their coding agent, ready to copy or open in Cursor. */
export function Prompt({ description, text }: { description: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="not-prose my-6 rounded-xl border bg-fd-card text-sm">
      <div className="flex flex-wrap items-center gap-3 p-3">
        <Sparkles className="size-4 shrink-0 text-fd-primary" aria-hidden="true" />
        <p className="m-0 min-w-0 flex-1 basis-56 text-fd-foreground">{description}</p>
        <div className="flex shrink-0 gap-2">
          <button type="button" className={button} onClick={copy} aria-live="polite">
            {copied ? <Check /> : <Copy />}
            {copied ? 'Copied' : 'Copy prompt'}
          </button>
          <a
            className={button}
            href={`https://cursor.com/link/prompt?${new URLSearchParams({ text })}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            {CURSOR_ICON}
            Open in Cursor
          </a>
        </div>
      </div>
      <details className="group border-t">
        <summary className="flex cursor-pointer list-none items-center gap-1 px-3 py-2 text-xs text-fd-muted-foreground hover:text-fd-foreground">
          <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
          Show the prompt
        </summary>
        <pre className="m-0 max-h-96 overflow-auto whitespace-pre-wrap px-3 pb-3 font-mono text-xs leading-relaxed text-fd-muted-foreground">
          {text}
        </pre>
      </details>
    </div>
  );
}
