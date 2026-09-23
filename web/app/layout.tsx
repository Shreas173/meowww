import type { Metadata, Viewport } from "next";
import { Instrument_Serif, Inter } from "next/font/google";
import type { ReactNode } from "react";
import SmoothScroll from "@/components/SmoothScroll";
import { library } from "@/lib/library";
import "./globals.css";

/**
 * Oversized editorial serif for headings. Instrument Serif ships a single
 * weight (400), so asking for anything else would fail the build.
 */
const display = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  display: "swap",
  variable: "--font-display",
});

/** Tracking-heavy sans used for every piece of metadata. Variable font. */
const meta = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-meta",
});

export const metadata: Metadata = {
  title: "Mathematics",
  description: `${library.stats.books} mathematics volumes across ${library.stats.topics} topics.`,
};

export const viewport: Viewport = {
  themeColor: "#07070a",
  colorScheme: "dark",
};

/**
 * Stays a server component so `metadata` can be exported from it. Lenis lives in
 * a client child (SmoothScroll) rather than here, because marking the root layout
 * "use client" would forfeit the metadata export.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${meta.variable}`}>
      <body>
        <SmoothScroll>{children}</SmoothScroll>
      </body>
    </html>
  );
}
