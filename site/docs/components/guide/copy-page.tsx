'use client';
import { buttonVariants } from 'fumadocs-ui/components/ui/button';
import { useCopyButton } from 'fumadocs-ui/utils/use-copy-button';
import { Check, Copy } from 'lucide-react';

/** Copies the page as Markdown, fetched from `href` exactly as given. */
export function CopyPageButton({ href }: { href: string }) {
  const [copied, onClick] = useCopyButton(() =>
    navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': fetch(href).then(async (res) => {
          if (!res.ok) throw new Error(`${href} answered ${res.status}`);
          return new Blob([await res.text()], { type: 'text/plain' });
        }),
      }),
    ]),
  );
  return (
    <button
      type="button"
      aria-live="polite"
      onClick={onClick}
      className={buttonVariants({
        variant: 'secondary',
        size: 'sm',
        className: 'gap-2 [&_svg]:size-3.5 [&_svg]:text-fd-muted-foreground',
      })}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? 'Copied' : 'Copy page'}
    </button>
  );
}
