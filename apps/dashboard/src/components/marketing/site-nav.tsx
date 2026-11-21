"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { auth } from "@/lib/api/endpoints";

const LINKS = [
  { href: "/#benefits", label: "Features" },
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#proof", label: "Security" },
  { href: "/docs", label: "Docs" },
  { href: "/#faq", label: "FAQ" },
];

export function SiteNav() {
  const [signedIn, setSignedIn] = useState<boolean>();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    auth.me().then(
      () => setSignedIn(true),
      () => setSignedIn(false),
    );
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [open]);

  const primary = signedIn ? (
    <Link href="/workspaces" className="button" data-variant="primary">
      Open dashboard
    </Link>
  ) : (
    <Link href="/sign-up" className="button" data-variant="primary">
      Create workspace
    </Link>
  );

  return (
    <>
      <header className="site-nav">
        <div className="site-nav-bar">
          <Link href="/" className="wordmark" aria-label="secure-cloud home">
            secure-cloud
          </Link>
          <nav aria-label="Site" className="site-links body-5">
            {LINKS.map((link) => (
              <a key={link.href} href={link.href}>
                {link.label}
              </a>
            ))}
          </nav>
          <div className="site-nav-actions">
            {signedIn === false && (
              <Link href="/login" className="site-nav-login body-5">
                Log in
              </Link>
            )}
            {primary}
            <button
              type="button"
              className="site-menu"
              aria-expanded={open}
              aria-controls="site-menu-panel"
              aria-label={open ? "Close menu" : "Open menu"}
              onClick={() => setOpen((value) => !value)}
            >
              <span className="site-menu-line" aria-hidden="true" />
              <span className="site-menu-line" aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>
      <nav
        id="site-menu-panel"
        className="site-menu-panel"
        aria-label="Menu"
        hidden={!open}
      >
        {open && (
          <>
            {LINKS.map((link, i) => (
              <a
                key={link.href}
                href={link.href}
                className="heading-5"
                style={{ animationDelay: `${Math.min(i * 60, 400)}ms` }}
                onClick={() => setOpen(false)}
              >
                {link.label}
              </a>
            ))}
            {signedIn === false && (
              <a
                href="/login"
                className="heading-5"
                style={{ animationDelay: `${LINKS.length * 60}ms` }}
              >
                Log in
              </a>
            )}
          </>
        )}
      </nav>
    </>
  );
}
