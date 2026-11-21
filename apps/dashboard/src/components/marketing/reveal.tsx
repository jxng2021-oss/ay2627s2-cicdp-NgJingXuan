"use client";

import type { ReactNode } from "react";
import { useInView } from "./use-in-view";

export function Reveal({
  children,
  delay = 0,
  className = "",
  as: Tag = "div",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
  as?: "div" | "li";
}) {
  const [ref, state] = useInView<HTMLDivElement & HTMLLIElement>(0.15);
  return (
    <Tag
      ref={ref}
      className={`reveal ${className}`}
      data-state={state}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </Tag>
  );
}
