import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
import { ThemeProvider } from "@/components/theme-provider";
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
  icons: {
    icon: "/icon.svg",
    shortcut: "/icon.svg",
  },
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
  // A5/H1: reading the per-request nonce header here is what tells Next.js to
  // stamp `nonce="..."` onto every framework-managed inline <script> (RSC
  // payload, hydration bootstrap, route prefetch). Without this call Next.js
  // doesn't know a nonce policy is in effect and the strict-dynamic CSP from
  // middleware.ts blocks every inline script it injects.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${inter.variable} font-sans antialiased min-h-screen bg-background text-foreground`}
        {...(nonce ? { "data-nonce": nonce } : {})}
      >
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
