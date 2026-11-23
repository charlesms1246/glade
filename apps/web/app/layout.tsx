import type { Metadata } from "next";
import { Fraunces, Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const fraunces = Fraunces({ variable: "--font-fraunces", subsets: ["latin"], axes: ["opsz"] });

export const metadata: Metadata = {
  title: "Glade · protection for tokenized stocks",
  description: "Shield, Floor and Bell: hedges for tokenized US stocks on True Markets, including when Wall Street is closed.",
};

const nav = [
  { href: "/bell", label: "Bell" },
  { href: "/replay", label: "Floor replay" },
  { href: "/verify", label: "Verify" },
];

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">
        <header className="border-b border-sand-deep/70">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
            <Link href="/" className="font-display text-2xl tracking-tight text-forest">
              Glade
            </Link>
            <nav className="flex gap-6 text-sm text-ink-soft">
              {nav.map((n) => (
                <Link key={n.href} href={n.href} className="hover:text-forest">
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="flex-1">{children}</main>
        <footer className="border-t border-sand-deep/70">
          <div className="mx-auto max-w-5xl px-6 py-6 text-xs leading-relaxed text-ink-soft">
            Glade shows estimates and targets, not guarantees. Hedges use perpetual futures, which carry funding costs and
            liquidation risk. Nothing here is investment advice. Market data: True Markets.
          </div>
        </footer>
      </body>
    </html>
  );
}
