import type { Metadata } from 'next';
import { Geist, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { Provider } from '@/components/provider';
import { appName, basePath, docsUrl } from '@/lib/shared';
import './global.css';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono' });

export const metadata: Metadata = {
  metadataBase: new URL(`${docsUrl}/`),
  title: { template: `%s · ${appName}`, default: appName },
  description:
    'A workspace for coding agents: run them side by side, see which one waits on you, and drive them from other computers, your phone or your own program.',
  icons: { icon: `${basePath}/favicon.png` },
  alternates: { types: { 'text/plain': `${basePath}/llms.txt` } },
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
