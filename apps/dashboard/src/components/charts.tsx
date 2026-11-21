"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export interface Series {
  key: string;
  label: string;
  color: string;
}

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const full = new Intl.NumberFormat("en-US");

export function formatCount(value: number): string {
  return value < 10_000 ? full.format(value) : compact.format(value);
}

export function niceMax(max: number): number {
  if (max <= 4) return 4;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * power >= max) return step * power;
  }
  return 10 * power;
}

function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element || !("ResizeObserver" in window)) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(240, Math.floor(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function topRounded(x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h);
  return [
    `M${x},${y + h}`,
    `V${y + radius}`,
    `Q${x},${y} ${x + radius},${y}`,
    `H${x + w - radius}`,
    `Q${x + w},${y} ${x + w},${y + radius}`,
    `V${y + h}`,
    "Z",
  ].join(" ");
}

export function Legend({ series }: { series: Series[] }) {
  return (
    <ul className="chart-legend">
      {series.map((s) => (
        <li key={s.key}>
          <span
            className="chart-swatch"
            style={{ background: s.color }}
            aria-hidden="true"
          />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

export interface Column {
  label: string;
  fullLabel: string;
  values: Record<string, number>;
}

export function StackedColumns({
  title,
  columns,
  series,
}: {
  title: string;
  columns: Column[];
  series: Series[];
}) {
  const [ref, width] = useWidth(640);
  const [active, setActive] = useState<number | null>(null);
  const height = 220;
  const margin = { top: 12, right: 24, bottom: 26, left: 40 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const totals = columns.map((c) =>
    series.reduce((sum, s) => sum + (c.values[s.key] ?? 0), 0),
  );
  const max = niceMax(Math.max(0, ...totals));
  const y = (value: number) => margin.top + plotH - (value / max) * plotH;
  const band = plotW / Math.max(1, columns.length);
  const barW = Math.max(2, Math.min(24, band - 2));
  const ticks = [0, max / 2, max];
  const fits = Math.max(2, Math.min(7, Math.floor(plotW / 64)));
  const every = Math.max(1, Math.ceil(columns.length / fits));

  function onKeyDown(event: KeyboardEvent) {
    const last = columns.length - 1;
    const current = active ?? last;
    const next =
      event.key === "ArrowLeft"
        ? Math.max(0, current - 1)
        : event.key === "ArrowRight"
          ? Math.min(last, current + 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    setActive(next);
  }

  const shown = active === null ? null : columns[active];
  const tipLeft = active === null ? 0 : margin.left + band * active + band / 2;

  return (
    <div className="chart">
      {series.length > 1 && <Legend series={series} />}
      <div
        ref={ref}
        className="chart-frame"
        tabIndex={0}
        role="group"
        aria-label={`${title}. Use the left and right arrow keys to read each day.`}
        onKeyDown={onKeyDown}
        onFocus={() => setActive((a) => a ?? columns.length - 1)}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
      >
        <svg
          width={width}
          height={height}
          className="chart-svg"
          aria-hidden="true"
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={margin.left}
                x2={width - margin.right}
                y1={y(tick)}
                y2={y(tick)}
                className="chart-grid"
              />
              <text
                x={margin.left - 8}
                y={y(tick) + 4}
                textAnchor="end"
                className="chart-tick"
              >
                {formatCount(tick)}
              </text>
            </g>
          ))}
          {columns.map((column, i) => {
            const x = margin.left + band * i + (band - barW) / 2;
            let top = y(0);
            const parts = series
              .map((s) => ({ s, value: column.values[s.key] ?? 0 }))
              .filter((p) => p.value > 0);
            return (
              <g key={column.fullLabel}>
                {active === i && (
                  <rect
                    x={margin.left + band * i}
                    y={margin.top}
                    width={band}
                    height={plotH}
                    className="chart-hover"
                  />
                )}
                <g
                  className="chart-grow"
                  style={{ animationDelay: `${Math.min(i, 30) * 18}ms` }}
                >
                  {parts.map((part, j) => {
                    const h = (part.value / max) * plotH;
                    const gap = j > 0 ? 2 : 0;
                    const segmentH = Math.max(1, h - gap);
                    const segmentY = top - gap - segmentH;
                    top = segmentY;
                    const isTop = j === parts.length - 1;
                    return isTop ? (
                      <path
                        key={part.s.key}
                        d={topRounded(x, segmentY, barW, segmentH, 4)}
                        fill={part.s.color}
                      />
                    ) : (
                      <rect
                        key={part.s.key}
                        x={x}
                        y={segmentY}
                        width={barW}
                        height={segmentH}
                        fill={part.s.color}
                      />
                    );
                  })}
                </g>
                {i % every === (columns.length - 1) % every && (
                  <text
                    x={margin.left + band * i + band / 2}
                    y={height - 8}
                    textAnchor="middle"
                    className="chart-tick"
                  >
                    {column.label}
                  </text>
                )}
                <rect
                  x={margin.left + band * i}
                  y={margin.top}
                  width={band}
                  height={plotH}
                  fill="transparent"
                  onPointerEnter={() => setActive(i)}
                />
              </g>
            );
          })}
          <line
            x1={margin.left}
            x2={width - margin.right}
            y1={y(0)}
            y2={y(0)}
            className="chart-axis"
          />
        </svg>
        {shown && (
          <div
            className="chart-tooltip"
            style={{
              left: Math.min(Math.max(tipLeft, 80), width - 80),
            }}
            aria-live="polite"
          >
            <p className="chart-tooltip-title">{shown.fullLabel}</p>
            {[...series].reverse().map((s) => (
              <p key={s.key} className="chart-tooltip-row">
                <span
                  className="chart-key"
                  style={{ background: s.color }}
                  aria-hidden="true"
                />
                <strong>{formatCount(shown.values[s.key] ?? 0)}</strong>
                <span className="muted">{s.label}</span>
              </p>
            ))}
          </div>
        )}
      </div>
      <TableView
        caption={title}
        head={["Day", ...series.map((s) => s.label)]}
        rows={columns.map((c) => [
          c.fullLabel,
          ...series.map((s) => formatCount(c.values[s.key] ?? 0)),
        ])}
      />
    </div>
  );
}

export interface BarItem {
  label: string;
  values: Record<string, number>;
}

export function BarList({
  title,
  items,
  series,
}: {
  title: string;
  items: BarItem[];
  series: Series[];
}) {
  const totals = items.map((item) =>
    series.reduce((sum, s) => sum + (item.values[s.key] ?? 0), 0),
  );
  const max = Math.max(1, ...totals);
  return (
    <div className="chart">
      {series.length > 1 && <Legend series={series} />}
      <ul className="bar-list" aria-label={title}>
        {items.map((item, i) => {
          const parts = series.filter((s) => (item.values[s.key] ?? 0) > 0);
          const detail = series
            .map(
              (s) =>
                `${formatCount(item.values[s.key] ?? 0)} ${s.label.toLowerCase()}`,
            )
            .join(", ");
          return (
            <li key={item.label} className="bar-row" title={detail}>
              <span className="bar-label">{item.label}</span>
              <span className="bar-track">
                <span
                  className="bar"
                  style={{
                    width: `${(totals[i]! / max) * 100}%`,
                    animationDelay: `${i * 60}ms`,
                  }}
                >
                  {parts.map((s) => (
                    <span
                      key={s.key}
                      className="bar-segment"
                      style={{
                        background: s.color,
                        flexGrow: item.values[s.key] ?? 0,
                      }}
                    />
                  ))}
                </span>
                <span className="bar-value">{formatCount(totals[i]!)}</span>
              </span>
              {series.length > 1 && <span className="sr-only">: {detail}</span>}
            </li>
          );
        })}
      </ul>
      <TableView
        caption={title}
        head={[
          "",
          ...(series.length > 1 ? series.map((s) => s.label) : []),
          "Total",
        ]}
        rows={items.map((item, i) => [
          item.label,
          ...(series.length > 1
            ? series.map((s) => formatCount(item.values[s.key] ?? 0))
            : []),
          formatCount(totals[i]!),
        ])}
      />
    </div>
  );
}

function TableView({
  caption,
  head,
  rows,
}: {
  caption: string;
  head: string[];
  rows: string[][];
}) {
  return (
    <details className="chart-table">
      <summary>Show as table</summary>
      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {head.map((cell, i) => (
                <th key={i} scope="col">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) =>
                  j === 0 ? (
                    <th key={j} scope="row">
                      {cell}
                    </th>
                  ) : (
                    <td key={j}>{cell}</td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function Sparkline({ values }: { values: number[] }) {
  const w = 120;
  const h = 32;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? (w - 8) / (values.length - 1) : 0;
  const points = values.map(
    (v, i) => [4 + i * step, h - 5 - (v / max) * (h - 10)] as const,
  );
  const last = points.at(-1);
  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      aria-hidden="true"
    >
      <polyline
        points={points.map(([x, y]) => `${x},${y}`).join(" ")}
        className="sparkline-line"
        pathLength={1}
      />
      {last && (
        <circle cx={last[0]} cy={last[1]} r={4} className="sparkline-dot" />
      )}
    </svg>
  );
}

export function StatTile({
  label,
  value,
  previous,
  trend,
  period,
  upIsGood = true,
  children,
}: {
  label: string;
  value: number;
  previous: number;
  trend: number[];
  period: string;
  upIsGood?: boolean;
  children?: ReactNode;
}) {
  const change = value - previous;
  const direction = change > 0 ? "up" : change < 0 ? "down" : "flat";
  const percent =
    previous > 0 ? `${Math.round((Math.abs(change) / previous) * 100)}%` : null;
  const words =
    direction === "flat"
      ? `No change from ${period}`
      : percent
        ? `${direction === "up" ? "Up" : "Down"} ${percent} from ${period}`
        : `Up from 0 in ${period}`;
  const tone =
    direction === "flat"
      ? "flat"
      : (direction === "up") === upIsGood
        ? "good"
        : "bad";
  return (
    <section className="card stat-tile" data-tone={tone} aria-label={label}>
      <p className="sec-label">{label}</p>
      <div className="stat-tile-body">
        <p className="stat-value">
          <CountUp value={value} />
        </p>
        <Sparkline values={trend} />
      </div>
      <p className="stat-delta" data-tone={tone}>
        <span aria-hidden="true" className="stat-arrow">
          {direction === "up" ? "▲" : direction === "down" ? "▼" : "■"}
        </span>
        {words}
      </p>
      {children}
    </section>
  );
}

export function CountUp({ value }: { value: number }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (
      value === 0 ||
      typeof window.matchMedia !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setShown(value);
      return;
    }
    const start = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const t = Math.min(1, (now - start) / 1000);
      setShown(Math.round(value * (1 - (1 - t) ** 3)));
      if (t < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return (
    <>
      <span aria-hidden="true">{formatCount(shown)}</span>
      <span className="sr-only">{formatCount(value)}</span>
    </>
  );
}
