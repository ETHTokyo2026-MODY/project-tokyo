import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Nav } from '@/components/Nav';
import { ChainProvider } from '@/lib/chain/store';
import './globals.css';

export const metadata: Metadata = {
  title: 'Dashboard · DayTrader',
  description:
    'A market where hosts presell future room-nights and traders set the price.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <ChainProvider>
          <Suspense
            fallback={
              <nav id="nav" aria-label="Main">
                <span className="brand">
                  DayTrader<small>Loading…</small>
                </span>
              </nav>
            }
          >
            <Nav />
          </Suspense>
          <Suspense
            fallback={
              <main className="page">
                <h1>Dashboard</h1>
                <div className="muted">Loading…</div>
              </main>
            }
          >
            {children}
          </Suspense>
        </ChainProvider>
      </body>
    </html>
  );
}
