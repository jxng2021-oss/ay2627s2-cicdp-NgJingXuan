import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { ApiConfig } from "@/components/api-config";
import { apiOriginFromEnv } from "@/lib/api/origin";
import { SessionGate } from "@/lib/session";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";
import { ToastProvider } from "@/lib/toast";
import "./globals.css";

export const metadata: Metadata = {
  title: "Secure cloud platform",
  description:
    "Manage your workspace's API keys, secrets, files and audit log.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      data-theme={theme === "system" ? undefined : theme}
    >
      <body>
        <ApiConfig origin={apiOriginFromEnv()} />
        <ToastProvider>
          <SessionGate>{children}</SessionGate>
        </ToastProvider>
      </body>
    </html>
  );
}
