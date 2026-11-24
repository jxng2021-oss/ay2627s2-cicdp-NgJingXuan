import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import Link from "next/link";
import type { ReactNode } from "react";
import { signOut } from "./account/actions";
import "./globals.css";
import "./shop.css";
import { currentShopper } from "@/lib/shoppers";

export const metadata: Metadata = {
  title: "Demo Shop",
  description:
    "A demo shop that keeps its photos and keys on secure-cloud and pays with Stripe through it.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  const shopper = await currentShopper();
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <header className="shop-header">
          <Link href="/" className="wordmark">
            demo-shop
          </Link>
          <nav aria-label="Shop" className="shop-nav">
            <Link href="/">Products</Link>
            {shopper ? (
              <>
                <Link href="/account/orders">My Orders</Link>
                <form action={signOut}>
                  <button type="submit" className="link-button">
                    Sign Out
                  </button>
                </form>
              </>
            ) : (
              <Link href="/account/sign-in">Sign In</Link>
            )}
            <Link href="/admin">Admin</Link>
          </nav>
        </header>
        <main className="shop-main">{children}</main>
        <footer className="shop-footer">
          <p className="muted">
            A demo customer of secure-cloud: photos, keys and shopper accounts
            are kept on the platform; orders are in the shop&apos;s own
            database. Test data only.
          </p>
        </footer>
      </body>
    </html>
  );
}
