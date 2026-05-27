import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
import { ThemeProvider } from "@/components/theme-provider";
import { I18nProvider } from "@/components/i18n-provider";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "PermitForge - Building Code Compliance Assistant",
  description: "AI-powered compliance checking for building codes. Get instant answers about parking requirements, fire safety, building heights, and more.",
  keywords: ["building code", "compliance", "parking requirements", "construction permits", "regulations"],
  authors: [{ name: "PermitForge" }],
  // No explicit `icons` — Next.js auto-detects app/icon.svg and emits the
  // proper <link rel="icon" type="image/svg+xml" href="/icon.svg?<hash>" />
  // tag, so modern browsers no longer probe /favicon.ico.
  openGraph: {
    title: "PermitForge - Building Code Compliance Assistant",
    description: "AI-powered compliance checking for building codes",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // A5/H1: touching headers() opts the layout into dynamic rendering, which
  // is what tells Next.js to stamp the per-request `x-nonce` (set by
  // middleware) onto every framework-injected inline <script>. We don't need
  // the value here — just the side-effect of reading the request headers is
  // enough. try/catch is defensive: in error-page render paths (e.g. when a
  // server action throws), Next.js may invoke this layout without a live
  // request context, and we don't want the CSP nonce hookup to mask the
  // original error.
  try {
    await headers();
  } catch {
    // No-op: nonce detection is best-effort.
  }

  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${inter.variable} font-sans antialiased min-h-screen bg-background text-foreground`}
      >
        <ThemeProvider>
          <I18nProvider>{children}</I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
