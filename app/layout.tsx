import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost:4173";
  const protocol = host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https";
  const base = new URL(`${protocol}://${host}`);
  const description =
    "A fast, mobile-ready low-poly police pursuit. Dodge roadblocks, use nitro, and reach the extraction gate.";

  return {
    metadataBase: base,
    title: "Heatline Pursuit — Outrun the Law",
    description,
    applicationName: "Heatline Pursuit",
    category: "game",
    openGraph: {
      type: "website",
      title: "Heatline Pursuit — Outrun the Law",
      description,
      images: [{ url: new URL("/og.png", base).toString(), width: 1736, height: 906 }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Heatline Pursuit — Outrun the Law",
      description,
      images: [new URL("/og.png", base).toString()],
    },
  };
}

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
