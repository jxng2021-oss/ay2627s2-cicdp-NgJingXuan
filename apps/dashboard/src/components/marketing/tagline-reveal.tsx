"use client";

import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "./use-in-view";

export function TaglineReveal({
  lines,
  className = "",
}: {
  lines: string[];
  className?: string;
}) {
  const words = lines.map((line) => line.split(" "));
  const total = words.flat().length;
  const refs = useRef<(HTMLSpanElement | null)[]>([]);
  const [lit, setLit] = useState(0);

  useEffect(() => {
    if (prefersReducedMotion() || !("IntersectionObserver" in window)) {
      setLit(total);
      return;
    }
    let target = 0;
    let shown = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = () => {
      if (shown >= target) {
        timer = undefined;
        return;
      }
      shown += 1;
      setLit(shown);
      timer = setTimeout(step, 60);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = Number((entry.target as HTMLElement).dataset.index);
          target = Math.max(target, index + 1);
          observer.unobserve(entry.target);
        }
        if (timer === undefined) step();
      },
      { rootMargin: "0px 0px -40% 0px" },
    );
    for (const element of refs.current) if (element) observer.observe(element);
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [total]);

  let index = 0;
  return (
    <p className={`tagline ${className}`}>
      <span className="sr-only">{lines.join(" ")}</span>
      <span aria-hidden="true">
        {words.map((line, l) => (
          <span key={l} className="tagline-line">
            {line.map((word, w) => {
              const i = index++;
              return (
                <span key={w}>
                  <span
                    ref={(element) => {
                      refs.current[i] = element;
                    }}
                    data-index={i}
                    data-on={i < lit}
                    className="tagline-word"
                  >
                    {word}
                  </span>
                  {w < line.length - 1 ? " " : ""}
                </span>
              );
            })}
            {l < words.length - 1 && <br />}
          </span>
        ))}
      </span>
    </p>
  );
}
