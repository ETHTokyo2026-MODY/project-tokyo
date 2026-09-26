import type { Metadata } from 'next';
import { DemoProvider } from '@/lib/demo/store';
import './globals.css';

export const metadata: Metadata = {
  title: 'Project Tokyo',
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
        <DemoProvider>{children}</DemoProvider>
      </body>
    </html>
  );
}
