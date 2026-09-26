import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Nav } from '@/components/Nav';
import { DemoProvider } from '@/lib/demo/store';
import './globals.css';

export const metadata: Metadata = {
  title: 'Dashboard · Project Tokyo (demo)',
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
        <DemoProvider>
          <Suspense
            fallback={
              <nav id="nav" aria-label="Main">
                <span className="brand">
                  Project Tokyo<small>demo · sample data</small>
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
                <div className="muted">Loading demo…</div>
              </main>
            }
          >
            {children}
          </Suspense>
        </DemoProvider>
      </body>
    </html>
  );
}
