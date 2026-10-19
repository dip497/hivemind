import { DocsLayout } from 'fumadocs-ui/layouts/notebook';
import { Download } from 'lucide-react';
import type { ReactNode } from 'react';
import { Logo } from '@/components/logo';
import { source } from '@/lib/source';
import { downloadUrl, repoUrl } from '@/lib/shared';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      tabMode="navbar"
      nav={{ title: <Logo />, url: '/', mode: 'top' }}
      githubUrl={repoUrl}
      links={[
        {
          type: 'button',
          text: 'Download',
          url: downloadUrl,
          external: true,
          icon: <Download />,
          on: 'nav',
        },
      ]}
    >
      {children}
    </DocsLayout>
  );
}
