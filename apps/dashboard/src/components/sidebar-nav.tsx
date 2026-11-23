"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { Icon } from "@/components/icons";
import type { NavGroup, NavItem } from "@/lib/nav";

function isCurrent(pathname: string, href: string, root: boolean): boolean {
  return pathname === href || (!root && pathname.startsWith(`${href}/`));
}

function NavEntry({
  item,
  base,
  pathname,
}: {
  item: NavItem;
  base: string;
  pathname: string;
}) {
  const listId = useId();
  const children = item.children ?? [];
  const inside = children.some((child) =>
    isCurrent(pathname, `${base}${child.path}`, false),
  );
  const [expanded, setExpanded] = useState(inside);
  useEffect(() => {
    if (inside) setExpanded(true);
  }, [inside]);
  const icon = (
    <span className="nav-icon" aria-hidden="true">
      <Icon name={item.icon} size={18} weight="light" />
    </span>
  );

  if (children.length === 0) {
    const href = `${base}${item.path}`;
    return (
      <li>
        <Link
          href={href}
          aria-current={
            isCurrent(pathname, href, item.path === "") ? "page" : undefined
          }
        >
          {icon}
          {item.label}
        </Link>
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        className="nav-toggle"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded((open) => !open)}
      >
        {icon}
        {item.label}
        <span className="nav-caret" aria-hidden="true">
          <Icon name="chevron-down" size={16} />
        </span>
      </button>
      <ul id={listId} className="nav-sub" hidden={!expanded}>
        {children.map((child) => {
          const href = `${base}${child.path}`;
          return (
            <li key={child.path}>
              <Link
                href={href}
                aria-current={
                  isCurrent(pathname, href, false) ? "page" : undefined
                }
              >
                {child.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

export function SidebarNav({
  groups,
  base,
  pathname,
}: {
  groups: NavGroup[];
  base: string;
  pathname: string;
}) {
  return (
    <nav className="nav" aria-label="Workspace">
      {groups.map((group) => {
        const groupId = `nav-${group.label.toLowerCase().replace(/\s+/g, "-")}`;
        return (
          <div className="nav-group" key={group.label}>
            <p className="eyebrow" id={groupId}>
              {group.label}
            </p>
            <ul aria-labelledby={groupId}>
              {group.items.map((item) => (
                <NavEntry
                  key={item.path}
                  item={item}
                  base={base}
                  pathname={pathname}
                />
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
