import type { Metadata } from "next";
import { Fraunces, Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";
import { PaperBadge } from "@/components/paper-badge";
import { UserNav } from "@/components/user-nav";
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
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 py-5">
            <div className="flex items-center gap-4">
              <Link href="/" className="font-display text-2xl tracking-tight text-forest">
                Glade
              </Link>
              <PaperBadge />
            </div>
            <nav className="-mx-6 flex w-[calc(100%+3rem)] items-center gap-x-5 overflow-x-auto whitespace-nowrap px-6 text-sm text-ink-soft sm:mx-0 sm:w-auto sm:justify-end sm:gap-x-6 sm:px-0">
              {nav.map((n) => (
                <Link key={n.href} href={n.href} className="hover:text-forest">
                  {n.label}
                </Link>
              ))}
              <Suspense fallback={null}>
                <UserNav />
              </Suspense>
            </nav>
          </div>
        </header>
        <main className="flex-1">{children}</main>
        <footer className="border-t border-sand-deep/70">
          <div className="mx-auto max-w-5xl px-6 py-6 text-xs leading-relaxed text-ink-soft">
            Glade shows estimates and targets, not guarantees. Hedges use perpetual futures, which carry funding costs and
            liquidation risk. Paper trading: balances and fills are simulated, no real money moves. Nothing here is investment
            advice. Market data: True Markets.
          </div>
        </footer>
      </body>
    </html>
  );
}
