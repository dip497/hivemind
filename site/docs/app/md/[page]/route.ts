import { notFound } from 'next/navigation';
import { pageMarkdown, source } from '@/lib/source';

export const revalidate = false;

// Written as md/<page>.md; the build moves each one next to its page, as <page>.md.
export async function GET(_request: Request, { params }: { params: Promise<{ page: string }> }) {
  const name = (await params).page.replace(/\.md$/, '');
  const page = source.getPage(name === 'index' ? [] : name.split('~'));
  if (!page) notFound();
  return new Response(await pageMarkdown(page), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({ page: `${page.slugs.length === 0 ? 'index' : page.slugs.join('~')}.md` }));
}
