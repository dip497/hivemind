'use client';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import type { OpenLink } from '@/lib/open-in';

/**
 * A dropdown of links. Its links are in the page's HTML even while it is closed, so the link check
 * sees every one of them.
 */
export function OpenMenu({
  label,
  links,
  className,
  align = 'start',
}: {
  label: ReactNode;
  links: OpenLink[];
  className: string;
  align?: 'start' | 'end';
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const details = menu.current;
      if (details?.open && !details.contains(event.target as Node)) details.open = false;
    };
    const onKey = (event: KeyboardEvent) => {
      const details = menu.current;
      if (event.key !== 'Escape' || !details?.open) return;
      details.open = false;
      details.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <details ref={menu} className="group/open relative">
      <summary
        className={`${className} cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden group-open/open:bg-fd-accent group-open/open:text-fd-accent-foreground`}
      >
        {label}
        <ChevronDown className="size-3.5 text-fd-muted-foreground" aria-hidden="true" />
      </summary>
      <div
        className={`absolute top-full z-50 mt-1 flex w-max min-w-[240px] max-w-[min(98vw,320px)] flex-col rounded-xl border bg-fd-popover p-2 text-sm text-fd-popover-foreground shadow-lg ${align === 'end' ? 'end-0' : 'start-0'}`}
      >
        {links.map((link) => (
          <a
            key={link.name}
            href={link.href}
            target="_blank"
            rel="noreferrer noopener nofollow"
            onClick={() => {
              if (menu.current) menu.current.open = false;
            }}
            className="inline-flex items-center gap-2 rounded-lg p-2 text-sm hover:bg-fd-accent hover:text-fd-accent-foreground [&_svg]:size-4"
          >
            {link.icon}
            {link.name}
            <ExternalLink className="ms-auto size-3.5 text-fd-muted-foreground" aria-hidden="true" />
          </a>
        ))}
      </div>
    </details>
  );
}
