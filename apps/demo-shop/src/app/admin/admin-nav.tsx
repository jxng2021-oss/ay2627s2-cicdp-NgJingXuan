"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { adminSignOut } from "../admin-login/actions";

const ITEMS = [
  { href: "/admin", label: "Platform" },
  { href: "/admin/products", label: "Product Photos" },
  { href: "/admin/orders", label: "Orders" },
  { href: "/admin/activity", label: "Activity" },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Admin" className="admin-nav">
      {ITEMS.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={pathname === item.href ? "page" : undefined}
        >
          {item.label}
        </Link>
      ))}
      <form action={adminSignOut} className="admin-nav-signout">
        <button type="submit" className="button" data-variant="ghost">
          Sign out
        </button>
      </form>
    </nav>
  );
}
