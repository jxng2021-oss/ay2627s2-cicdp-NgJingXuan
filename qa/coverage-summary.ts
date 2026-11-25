import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Totals {
  lines: number;
  statements: number;
  functions: number;
  branches: number | null;
}

const TYPESCRIPT_PARTS = [
  "gateway",
  "audit",
  "identity",
  "flags",
  "dashboard",
  "sdk",
  "demo-shop",
];
const COVERAGE_DIR = "qa/coverage";

function readJson<T>(path: string): T | undefined {
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as T)
    : undefined;
}

function typescriptTotals(part: string): Totals | undefined {
  const summary = readJson<{
    total: Record<keyof Totals, { pct: number }>;
  }>(join(COVERAGE_DIR, part, "coverage-summary.json"));
  if (!summary) return undefined;
  return {
    lines: summary.total.lines.pct,
    statements: summary.total.statements.pct,
    functions: summary.total.functions.pct,
    branches: summary.total.branches.pct,
  };
}

function rustTotals(): Totals | undefined {
  const report = readJson<{
    data: {
      totals: {
        lines: { percent: number };
        regions: { percent: number };
        functions: { percent: number };
        branches?: { count: number; percent: number };
      };
    }[];
  }>(join(COVERAGE_DIR, "rust", "coverage-summary.json"));
  const totals = report?.data[0]?.totals;
  if (!totals) return undefined;
  return {
    lines: totals.lines.percent,
    statements: totals.regions.percent,
    functions: totals.functions.percent,
    branches:
      totals.branches && totals.branches.count > 0
        ? totals.branches.percent
        : null,
  };
}

const percent = (value: number | null) =>
  value === null ? "n/a" : `${value.toFixed(1)}%`;

const rows: [string, Totals | undefined][] = [
  ...TYPESCRIPT_PARTS.map(
    (part) => [part, typescriptTotals(part)] as [string, Totals | undefined],
  ),
  ["secrets and storage (Rust)", rustTotals()],
];

const missing = rows.filter(([, totals]) => !totals).map(([part]) => part);
const table = [
  "| Part | Lines | Statements | Functions | Branches |",
  "| --- | --- | --- | --- | --- |",
  ...rows
    .filter((row): row is [string, Totals] => row[1] !== undefined)
    .map(
      ([part, t]) =>
        `| ${part} | ${percent(t.lines)} | ${percent(t.statements)} | ${percent(t.functions)} | ${percent(t.branches)} |`,
    ),
].join("\n");

const report = `## Unit test coverage\n\n${table}\n\nRust statements are LLVM regions. HTML reports are in the coverage artifact.\n`;
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
}
if (missing.length > 0) {
  console.error(`No coverage report for: ${missing.join(", ")}`);
  process.exit(1);
}
