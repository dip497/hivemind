import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  EditOnGitHub,
} from 'fumadocs-ui/layouts/notebook/page';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { buttonVariants } from 'fumadocs-ui/components/ui/button';
import { TextIcon } from 'lucide-react';
import { CopyPageButton } from '@/components/guide/copy-page';
import { OpenMenu } from '@/components/guide/open-menu';
import { getMDXComponents } from '@/components/mdx';
import { openInAgents, openInGitHub } from '@/lib/open-in';
import { source } from '@/lib/source';
import {
  appName,
  docsUrl,
  ogImage,
  pageAddress,
  pageMarkdownAddress,
  pageMarkdownPath,
  siteUrl,
  sourceUrl,
} from '@/lib/shared';

type Props = { params: Promise<{ slug?: string[] }> };

/**
 * What a search engine or an answer engine needs to place a page without guessing: an article in
 * the Hivemind guide, on the Hivemind website, with the trail that leads to it.
 */
function structuredData(page: NonNullable<ReturnType<typeof source.getPage>>) {
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
    ],
  };
}

export default async function Page(props: Props) {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const markdownPath = pageMarkdownPath(page.slugs);
  // An agent reads the Markdown copy best, and it has to be a full address it can fetch.
  const openLinks = [
    openInGitHub(sourceUrl(page.path)),
    { name: 'View as Markdown', href: markdownPath, icon: <TextIcon /> },
    ...openInAgents(`Read ${pageMarkdownAddress(page.slugs)}, I want to ask questions about it.`),
  ];

  return (
    <DocsPage toc={page.data.toc} full={page.data.mode === 'wide'} tableOfContent={{ style: 'clerk' }}>
      <script
        type="application/ld+json"
        // JSON.stringify cannot end the script early except through "</": escape it.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData(page)).replace(/</g, '\\u003c') }}
      />
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
      <div className="flex flex-row flex-wrap gap-2 items-center border-b pb-6">
        <CopyPageButton href={markdownPath} />
        <OpenMenu
          label="Open"
          links={openLinks}
          className={buttonVariants({ variant: 'secondary', size: 'sm', className: 'gap-2' })}
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
  const title = page.slugs.length === 0 ? `${appName} guide` : `${page.data.title} · ${appName}`;
  return {
    title: page.slugs.length === 0 ? { absolute: `${appName} guide` } : page.data.title,
    description: page.data.description,
    // Full addresses only: a path here would be joined onto metadataBase's /guide.
    alternates: {
      canonical: url,
      types: { 'text/markdown': pageMarkdownAddress(page.slugs) },
    },
    // Set whole: a page's openGraph replaces the layout's rather than adding to it.
    openGraph: {
      title,
      description: page.data.description,
      url,
      siteName: appName,
      type: 'article',
      images: [{ url: ogImage, width: 1200, height: 630, alt: `${appName}: coding agents side by side on one canvas` }],
    },
    twitter: { card: 'summary_large_image', title, description: page.data.description, images: [ogImage] },
  };
}
