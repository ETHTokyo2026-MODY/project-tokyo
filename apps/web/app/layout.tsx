import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Night Market',
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
      <body>{children}</body>
    </html>
  );
}
