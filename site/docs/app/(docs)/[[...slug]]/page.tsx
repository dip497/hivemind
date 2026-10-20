import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  EditOnGitHub,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from 'fumadocs-ui/layouts/notebook/page';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '@/components/mdx';
import { source } from '@/lib/source';
import { appName, cardAlt, docsUrl, ogImage, pageAddress, pageMarkdownPath, siteUrl, sourceUrl } from '@/lib/shared';

type Props = { params: Promise<{ slug?: string[] }> };

/** The guide's front page in a search result: what Hivemind runs, in the words people search. */
const homeTitle = `${appName} guide: run Claude Code, Codex and any coding agent`;

/**
 * What a search engine or an answer engine needs to place a page without guessing: an article in
 * the Hivemind guide, on the Hivemind website, with the trail that leads to it.
 */
function structuredData(page: NonNullable<ReturnType<typeof source.getPage>>, markdown: string) {
  const url = pageAddress(page.url);
  const isHome = page.slugs.length === 0;
  const trail = [
    { name: appName, item: `${siteUrl}/` },
    { name: 'Guide', item: `${docsUrl}/` },
    ...(isHome ? [] : [{ name: page.data.title, item: url }]),
  ];
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'TechArticle',
        '@id': `${url}#article`,
        headline: isHome ? `${appName} guide` : page.data.title,
        description: page.data.description,
        url,
        image: ogImage,
        inLanguage: 'en',
        isPartOf: { '@id': `${siteUrl}/#website` },
        about: { '@id': `${siteUrl}/#software` },
        publisher: { '@id': `${siteUrl}/#organization` },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: trail.map((step, i) => ({ '@type': 'ListItem', position: i + 1, ...step })),
      },
      ...questionsAndAnswers(url, markdown),
    ],
  };
}

/** A page whose every section heading is a question (the FAQ) is a FAQPage too, answered by its text. */
function questionsAndAnswers(url: string, markdown: string) {
  // A processed heading ends in its anchor: "## Is it free? [#is-it-free]".
  const sections = markdown.split(/^## /m).slice(1).map((s) => s.replace(/^([^\n]*?)\s*\[#[^\]\n]+\]/, '$1'));
  if (sections.length < 3 || !sections.every((s) => /^[^\n]+\?\s*\n/.test(s))) return [];
  const plain = (md: string) =>
    md
      .replace(/<[^>]+>/g, '')
      .replace(/^\s*[-*]\s+/gm, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[`*_]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  return [
    {
      '@type': 'FAQPage',
      '@id': `${url}#faq`,
      mainEntity: sections.map((section) => {
        const [question, ...rest] = section.split('\n');
        return { '@type': 'Question', name: question.trim(), acceptedAnswer: { '@type': 'Answer', text: plain(rest.join('\n')) } };
      }),
    },
  ];
}

export default async function Page(props: Props) {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const markdown = await page.data.getText('processed');
  const markdownUrl = pageMarkdownPath(page.slugs);

  return (
    <DocsPage toc={page.data.toc} full={page.data.mode === 'wide'} tableOfContent={{ style: 'clerk' }}>
      <script
        type="application/ld+json"
        // JSON.stringify cannot end the script early except through "</": escape it.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData(page, markdown)).replace(/</g, '\\u003c') }}
      />
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
      <div className="flex flex-row flex-wrap gap-2 items-center border-b pb-6">
        <MarkdownCopyButton markdownUrl={markdownUrl}>Copy page</MarkdownCopyButton>
        <ViewOptionsPopover
          markdownUrl={markdownUrl}
          pageUrl={`${docsUrl}${page.url}`}
          githubUrl={sourceUrl(page.path)}
        />
      </div>
      <DocsBody>
        <MDX components={getMDXComponents({ a: createRelativeLink(source, page) })} />
      </DocsBody>
      <EditOnGitHub href={sourceUrl(page.path, 'edit')} />
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();
  const url = pageAddress(page.url);
  const title = page.slugs.length === 0 ? homeTitle : `${page.data.title} · ${appName}`;
  return {
    title: page.slugs.length === 0 ? { absolute: homeTitle } : page.data.title,
    description: page.data.description,
    // Full addresses only: a path here would be joined onto metadataBase's /guide.
    alternates: {
      canonical: url,
      types: { 'text/markdown': `${siteUrl}${pageMarkdownPath(page.slugs)}` },
    },
    // Set whole: a page's openGraph replaces the layout's rather than adding to it.
    openGraph: {
      title,
      description: page.data.description,
      url,
      siteName: appName,
      type: 'article',
      images: [{ url: ogImage, width: 1200, height: 630, alt: cardAlt }],
    },
    twitter: { card: 'summary_large_image', title, description: page.data.description, images: [ogImage] },
  };
}
