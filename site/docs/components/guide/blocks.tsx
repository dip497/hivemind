import { Card as FumaCard, Cards } from 'fumadocs-ui/components/card';
import { Callout } from 'fumadocs-ui/components/callout';
import {
  CodeBlockTab,
  CodeBlockTabs,
  CodeBlockTabsList,
  CodeBlockTabsTrigger,
} from 'fumadocs-ui/components/codeblock';
import { ServerCodeBlock } from 'fumadocs-ui/components/codeblock.rsc';
import { Step as FumaStep, Steps as FumaSteps } from 'fumadocs-ui/components/steps';
import { Tab as FumaTab, Tabs as FumaTabs } from 'fumadocs-ui/components/tabs';
import {
  Code,
  Key,
  Layers,
  List,
  Plug,
  Puzzle,
  Rocket,
  Bot,
  Server,
  Smartphone,
  Terminal,
  Users,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { Children, Fragment, type ReactElement, type ReactNode, cloneElement, isValidElement } from 'react';
import { docsUrl, validatedFor } from '@/lib/shared';
import { Prompt } from './prompt';

type WithChildren = { children?: ReactNode };

/** The elements among a component's children, skipping the whitespace and fragments MDX leaves around them. */
function elements<P>(children: ReactNode): ReactElement<P>[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<WithChildren>(child)) return [];
    return child.type === Fragment ? elements<P>(child.props.children) : [child as ReactElement<P>];
  });
}

// ── Prompts ──────────────────────────────────────────────────────────────────

/** A page's copy-ready prompt; it ends with the page itself as Markdown, for the agent to read. */
export function AgentPrompt({ description, page, children }: { description: string; page: string } & WithChildren) {
  const text = `${String(children).trim()}\n\nREFERENCE ${docsUrl}/${page}.md`;
  return <Prompt description={description} text={text} />;
}

// ── Callouts ─────────────────────────────────────────────────────────────────

export const Note = ({ children }: WithChildren) => <Callout type="info">{children}</Callout>;
export const Info = ({ children }: WithChildren) => <Callout type="info">{children}</Callout>;
export const Tip = ({ children }: WithChildren) => <Callout type="idea">{children}</Callout>;
export const Warning = ({ children }: WithChildren) => <Callout type="warning">{children}</Callout>;
export const Check = ({ children }: WithChildren) => <Callout type="success">{children}</Callout>;

// ── Steps ────────────────────────────────────────────────────────────────────

export const Steps = ({ children }: WithChildren) => <FumaSteps>{children}</FumaSteps>;

export function Step({ title, children }: { title?: string } & WithChildren) {
  return (
    <FumaStep>
      {title ? <p className="!mt-0 !mb-2 font-semibold text-fd-foreground">{title}</p> : null}
      {children}
    </FumaStep>
  );
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

export function Tabs({ children }: WithChildren) {
  const tabs = elements<{ title: string } & WithChildren>(children);
  const titles = tabs.map((tab) => tab.props.title);
  return (
    <FumaTabs items={titles}>
      {tabs.map((tab) => (
        <FumaTab key={tab.props.title} value={tab.props.title}>
          {tab.props.children}
        </FumaTab>
      ))}
    </FumaTabs>
  );
}

/** Read by Tabs; on its own it shows its content. */
export const Tab = ({ children }: { title: string } & WithChildren) => <>{children}</>;

// ── Code ─────────────────────────────────────────────────────────────────────

/** Code blocks side by side as tabs, each named by its title: Linux and macOS, Windows. */
export function CodeGroup({ children }: WithChildren) {
  const blocks = elements<{ title?: string; filename?: string }>(children);
  const names = blocks.map((block, i) => block.props.title ?? block.props.filename ?? `Tab ${i + 1}`);
  return (
    <CodeBlockTabs defaultValue={names[0]}>
      <CodeBlockTabsList>
        {names.map((name) => (
          <CodeBlockTabsTrigger key={name} value={name}>
            {name}
          </CodeBlockTabsTrigger>
        ))}
      </CodeBlockTabsList>
      {blocks.map((block, i) => (
        <CodeBlockTab key={names[i]} value={names[i]}>
          {cloneElement(block, { title: undefined, filename: undefined })}
        </CodeBlockTab>
      ))}
    </CodeBlockTabs>
  );
}

/** A code block whose text is built in the page, such as a command with the version in it. */
export function CodeBlock({ filename, language, children }: { filename?: string; language: string } & WithChildren) {
  return <ServerCodeBlock lang={language} code={String(children)} codeblock={{ title: filename }} />;
}

// ── Cards ────────────────────────────────────────────────────────────────────

const ICONS: Record<string, LucideIcon> = {
  code: Code,
  key: Key,
  'layer-group': Layers,
  list: List,
  mobile: Smartphone,
  plug: Plug,
  'puzzle-piece': Puzzle,
  robot: Bot,
  rocket: Rocket,
  server: Server,
  terminal: Terminal,
  users: Users,
};

export function CardGroup({ cols = 2, children }: { cols?: number } & WithChildren) {
  return (
    <Cards className={cols >= 3 ? '@lg:grid-cols-3' : undefined} style={{ gridAutoRows: 'auto' }}>
      {children}
    </Cards>
  );
}

export function Card({
  title,
  icon,
  href,
  img,
  children,
}: { title: string; icon?: string; href?: string; img?: string } & WithChildren) {
  if (img) {
    const body = (
      <>
        <img src={img} alt="" loading="lazy" className="!m-0 aspect-video w-full rounded-t-xl border-b object-cover" />
        <span className="block p-4">
          <span className="block font-medium text-sm text-fd-card-foreground">{title}</span>
          <span className="mt-1 block text-sm text-fd-muted-foreground">{children}</span>
        </span>
      </>
    );
    const style = 'not-prose block overflow-hidden rounded-xl border bg-fd-card transition-colors';
    return href ? (
      <Link href={href} className={`${style} hover:bg-fd-accent/80`}>
        {body}
      </Link>
    ) : (
      <div className={style}>{body}</div>
    );
  }
  const Icon = icon ? ICONS[icon] : undefined;
  return (
    <FumaCard title={title} href={href} icon={Icon ? <Icon /> : undefined}>
      {children}
    </FumaCard>
  );
}

// ── Pictures and notes ───────────────────────────────────────────────────────

export function Frame({ caption, children }: { caption?: string } & WithChildren) {
  return (
    <figure className="guide-frame not-prose my-6 rounded-xl border bg-fd-card p-2">
      {children}
      {caption ? <figcaption className="px-2 pt-2 pb-1 text-center text-xs text-fd-muted-foreground">{caption}</figcaption> : null}
    </figure>
  );
}

/** A word with its meaning on hover or focus, and a link to read more. */
export function Tooltip({ tip, cta, href, children }: { tip: string; cta?: string; href?: string } & WithChildren) {
  return (
    <span className="group/tip relative inline-block">
      <span
        tabIndex={0}
        className="cursor-help underline decoration-dotted decoration-fd-muted-foreground underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-fd-ring rounded-sm"
      >
        {children}
      </span>
      <span
        role="tooltip"
        className="invisible absolute bottom-full left-1/2 z-30 mb-2 w-64 -translate-x-1/2 rounded-lg border bg-fd-popover p-3 text-xs leading-relaxed text-fd-popover-foreground opacity-0 shadow-lg transition-opacity group-focus-within/tip:visible group-focus-within/tip:opacity-100 group-hover/tip:visible group-hover/tip:opacity-100"
      >
        {tip}
        {href ? (
          <Link href={href} className="mt-1.5 block font-medium text-fd-primary no-underline">
            {cta ?? 'Read more'} →
          </Link>
        ) : null}
      </span>
    </span>
  );
}

/** One release in the changelog. */
export function Update({ label, description, children }: { label: string; description?: string } & WithChildren) {
  const id = `v${label.replace(/\./g, '-')}`;
  return (
    <section className="relative mt-10 border-t pt-6 first-of-type:border-t-0 first-of-type:pt-0">
      <div className="not-prose mb-3 flex items-baseline gap-3">
        <a href={`#${id}`} id={id} className="scroll-mt-28 rounded-md bg-fd-primary/10 px-2 py-0.5 font-mono text-sm font-medium text-fd-primary">
          {label}
        </a>
        {description ? <span className="text-sm text-fd-muted-foreground">{description}</span> : null}
      </div>
      {children}
    </section>
  );
}

// ── The release the pages describe ───────────────────────────────────────────

export const Version = () => <>{validatedFor}</>;

export function LastValidated() {
  return <p className="mt-10 text-xs text-fd-muted-foreground">Last validated for Hivemind {validatedFor}.</p>;
}

export function SdkInstall() {
  const release = `https://github.com/dip497/hivemind/releases/download/v${validatedFor}`;
  return (
    <Tabs>
      <Tab title="With the app">
        <p>The SDKs come with Hivemind, at the same version as the app.</p>
        <CodeGroup>
          <CodeBlock filename="macOS and Linux" language="bash">
            {'npm install ~/.hivemind-app/sdk/hivemind-api.tgz\npip install ~/.hivemind-app/sdk/python'}
          </CodeBlock>
          <CodeBlock filename="Windows (Command Prompt)" language="bat">
            {'npm install %LOCALAPPDATA%\\hivemind\\sdk\\hivemind-api.tgz\npip install %LOCALAPPDATA%\\hivemind\\sdk\\python'}
          </CodeBlock>
        </CodeGroup>
      </Tab>
      <Tab title="Without Hivemind">
        <p>On a computer without Hivemind, install them from a release. Use the version of the app your program talks to.</p>
        <CodeGroup>
          <CodeBlock filename="npm" language="bash">{`npm install ${release}/hivemind-api-${validatedFor}.tgz`}</CodeBlock>
          <CodeBlock filename="pip" language="bash">
            {`pip install ${release}/hivemind_api-${validatedFor}-py3-none-any.whl`}
          </CodeBlock>
          <CodeBlock filename="pip, from the repository" language="bash">
            {'pip install "git+https://github.com/dip497/hivemind#subdirectory=packages/sdk-python"'}
          </CodeBlock>
        </CodeGroup>
      </Tab>
    </Tabs>
  );
}
