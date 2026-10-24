/**
 * A Browser tile's site panel, by its address: the rights the page's site is asked about, each
 * with Allow, Block or Ask, as main keeps them until the app quits (main/permissions.ts). The
 * person answers before a site asks (one that reads Notification.permission first never asks)
 * and takes back an answer they gave.
 */
import { useEffect, useState } from "react";
import type { SiteRight } from "../../shared/ipc";
import { Popover } from "./components/ui/popover";
import { Button, buttonVariants } from "./components/ui/button";
import { Info } from "./components/icons";
import { SiteName } from "./browser-asks";
import { rightName } from "./site-words";

const ANSWERS: Array<[SiteRight["answer"], string, string]> = [
  ["allow", "Allow", "Allow"],
  ["block", "Block", "Block"],
  ["ask", "Ask", "Ask next time"],
];

/** The panel's button, for the page showing `site`; none for a page with no site to name. */
export function SiteButton({ site }: { site: string | null }) {
  if (!site || !window.hive.browserSiteRights) return null;
  return (
    <Popover label="Site permissions" align="left" width={264} trigger={<Info />}
      triggerClassName={buttonVariants({ variant: "ghost", size: "icon-2xs" })}>
      {() => <SiteRights site={site} />}
    </Popover>
  );
}

function SiteRights({ site }: { site: string }) {
  const [rights, setRights] = useState<SiteRight[]>([]);
  useEffect(() => {
    let live = true;
    void window.hive.browserSiteRights?.(site).then((list) => { if (live) setRights(list); });
    return () => { live = false; };
  }, [site]);
  const change = async (right: string, to: SiteRight["answer"]) => {
    await window.hive.setBrowserSiteRight?.(site, right, to);
    setRights((await window.hive.browserSiteRights?.(site)) ?? []);
  };
  return (
    <div className="nodrag flex flex-col gap-1 p-1" data-site-rights={site}>
      <p className="m-0 flex"><SiteName site={site} /></p>
      <p className="m-0 mb-1 text-count text-[var(--color-fg2)]">Your answers hold until you quit the app.</p>
      {rights.map(({ right, answer }) => (
        <div key={right} role="radiogroup" aria-label={rightName(right)} data-site-right={right} className="flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate">{rightName(right)}</span>
          {ANSWERS.map(([to, label, title]) => (
            <Button key={to} role="radio" aria-checked={answer === to} title={title} size="2xs"
              variant={answer === to ? "secondary" : "ghost"} onClick={() => void change(right, to)}>{label}</Button>
          ))}
        </div>
      ))}
    </div>
  );
}
