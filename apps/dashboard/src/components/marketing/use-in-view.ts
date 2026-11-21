"use client";

import { useEffect, useRef, useState } from "react";

export type ViewState = "idle" | "waiting" | "shown";

export function useInView<T extends Element>(threshold = 0.2) {
  const ref = useRef<T>(null);
  const [state, setState] = useState<ViewState>("idle");

  useEffect(() => {
    const element = ref.current;
    if (!element || !("IntersectionObserver" in window)) return;
    setState("waiting");
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setState("shown");
          observer.disconnect();
        }
      },
      { threshold },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [threshold]);

  return [ref, state] as const;
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
