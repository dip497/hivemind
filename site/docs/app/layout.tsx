import type { Metadata } from 'next';
import { Geist, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { Provider } from '@/components/provider';
import { appName, basePath, cardAlt, docsUrl, ogImage } from '@/lib/shared';
import './global.css';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono' });

const description =
  'How to use Hivemind, the app where Claude Code, Codex and every coding agent run side by side and build your own views, widgets and tools.';

export const metadata: Metadata = {
  metadataBase: new URL(`${docsUrl}/`),
  title: { template: `%s · ${appName}`, default: appName },
  description,
  icons: { icon: `${basePath}/favicon.png` },
  // A full address: a path here is joined onto metadataBase's /guide (see pageAddress).
  alternates: { types: { 'text/plain': `${docsUrl}/llms.txt` } },
  openGraph: {
    siteName: appName,
    type: 'website',
    images: [{ url: ogImage, width: 1200, height: 630, alt: cardAlt }],
  },
  twitter: { card: 'summary_large_image', images: [ogImage] },
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${mono.variable}`} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen font-sans">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
