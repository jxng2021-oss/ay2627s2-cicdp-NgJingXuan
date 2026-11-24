"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export const DOCS_PAGES = [
  { href: "/docs", label: "Quickstart" },
  { href: "/docs/connections", label: "Calling outside APIs" },
  { href: "/docs/files", label: "Files" },
  { href: "/docs/user-pools", label: "User sign in" },
  { href: "/docs/roles", label: "Roles and permissions" },
  { href: "/docs/flags", label: "Feature flags" },
  { href: "/docs/webhooks", label: "Payment webhooks" },
  { href: "/docs/express", label: "Express helpers" },
  { href: "/docs/errors", label: "Errors" },
];

export function DocsNav() {
  const pathname = usePathname();
  return (
    <nav className="docs-nav" aria-label="SDK docs">
      <p className="caption-3 muted">SDK for Node.js</p>
      <ul>
        {DOCS_PAGES.map((page) => (
          <li key={page.href}>
            <Link
              href={page.href}
              className="body-5"
              aria-current={pathname === page.href ? "page" : undefined}
            >
              {page.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function NextPage({ current }: { current: string }) {
  const index = DOCS_PAGES.findIndex((page) => page.href === current);
  const next = DOCS_PAGES[index + 1];
  if (!next) return null;
  return (
    <Link href={next.href} className="docs-next">
      <span className="caption-4 muted">Next</span>
      <span className="title-2">{next.label} →</span>
    </Link>
  );
}
