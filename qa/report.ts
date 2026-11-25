import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

type Status = "pass" | "fail" | "not-run" | "info";

interface SuiteResult {
  name: string;
  level: string;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number | null;
}

interface Coverage {
  part: string;
  lines: number;
  statements: number;
  functions: number;
  branches: number | null;
  coveredLines: number | null;
  totalLines: number | null;
  report: string | null;
}

interface Severities {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

const INPUT = process.env.QA_INPUT ?? "qa";
const OUTPUT = process.env.QA_OUTPUT ?? "qa/report";

const SUITES: Record<string, { name: string; level: string }> = {
  gateway: { name: "API gateway", level: "Unit and contract" },
  audit: { name: "Audit service", level: "Unit and contract" },
  identity: {
    name: "Identity service (user pools)",
    level: "Unit and contract",
  },
  flags: { name: "Flags service", level: "Unit and contract" },
  sdk: { name: "SDK", level: "Unit" },
  dashboard: { name: "Dashboard", level: "Unit" },
  "demo-shop": { name: "Demo shop", level: "Unit" },
  database: { name: "Database separation and migrations", level: "Database" },
  e2e: { name: "Whole stack", level: "End-to-end" },
  "dashboard-ui": { name: "Dashboard", level: "Browser (Playwright + axe)" },
  "demo-ui": {
    name: "Demo shop, with a real Stripe test checkout",
    level: "Browser",
  },
};

const COVERAGE_PARTS: Record<string, string> = {
  gateway: "API gateway",
  audit: "Audit service",
  identity: "Identity service",
  flags: "Flags service",
  sdk: "SDK",
  dashboard: "Dashboard (unit only)",
  "demo-shop": "Demo shop (unit only)",
  rust: "Secrets and storage (Rust)",
};

const JOBS: [key: string, name: string][] = [
  ["lint", "1.1 Lint and formatting"],
  ["typecheck", "1.2 Type check"],
  ["build", "1.3 Build all services"],
  ["unit-tests", "1.4 Unit and contract tests"],
  ["compatibility", "1.5 Encryption compatibility"],
  ["migrations", "1.6 Database migrations"],
  ["api-spec", "1.7 API spec up to date"],
  ["api-breaking-changes", "1.8 API breaking changes"],
  ["secret-scan", "1.9 Secret scan (Gitleaks)"],
  ["code-scan", "1.10 Code scan (Semgrep)"],
  ["dependency-scan", "1.11 Dependency scan (Trivy)"],
  ["rust-audit", "1.12 Rust dependency audit"],
  ["docker-build", "1.13 Build Docker images"],
  ["e2e", "2.1 End-to-end and browser tests"],
  ["image-scan", "2.2 Image scan (Trivy)"],
  ["ci-success", "3. All checks passed (the required check)"],
];

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    if (entry === "node_modules" || entry === ".git" || entry === "target")
      return [];
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
const number = (value: unknown): number =>
  typeof value === "number" ? value : 0;

function vitestSuite(
  json: Record<string, unknown>,
): Omit<SuiteResult, "name" | "level"> {
  const results = Array.isArray(json.testResults)
    ? json.testResults.map(record)
    : [];
  const ends = results.map((r) => number(r.endTime)).filter((t) => t > 0);
  const start = number(json.startTime);
  return {
    passed: number(json.numPassedTests),
    failed: number(json.numFailedTests),
    skipped: number(json.numPendingTests) + number(json.numTodoTests),
    durationMs: start > 0 && ends.length > 0 ? Math.max(...ends) - start : null,
  };
}

function playwrightSuite(
  json: Record<string, unknown>,
): Omit<SuiteResult, "name" | "level"> {
  const stats = record(json.stats);
  return {
    passed: number(stats.expected) + number(stats.flaky),
    failed: number(stats.unexpected),
    skipped: number(stats.skipped),
    durationMs: typeof stats.duration === "number" ? stats.duration : null,
  };
}

function rustSuite(log: string): SuiteResult | undefined {
  const totals = { passed: 0, failed: 0, skipped: 0 };
  let seen = false;
  for (const match of log.matchAll(
    /test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g,
  )) {
    seen = true;
    totals.passed += Number(match[1]);
    totals.failed += Number(match[2]);
    totals.skipped += Number(match[3]);
  }
  return seen
    ? {
        name: "Secrets and storage (Rust)",
        level: "Unit, contract and compatibility",
        ...totals,
        durationMs: null,
      }
    : undefined;
}

function coverageOf(
  path: string,
): Omit<Coverage, "coveredLines" | "totalLines" | "report"> | undefined {
  const part = basename(dirname(path));
  const json = record(readJson(path));
  if (part === "rust") {
    const totals = record(
      record((Array.isArray(json.data) ? json.data : [])[0]).totals,
    );
    const branches = record(totals.branches);
    return {
      part,
      lines: number(record(totals.lines).percent),
      statements: number(record(totals.regions).percent),
      functions: number(record(totals.functions).percent),
      branches: number(branches.count) > 0 ? number(branches.percent) : null,
    };
  }
  const total = record(json.total);
  if (!("lines" in total)) return undefined;
  const pct = (key: string) => number(record(total[key]).pct);
  return {
    part,
    lines: pct("lines"),
    statements: pct("statements"),
    functions: pct("functions"),
    branches: pct("branches"),
  };
}

function severities(json: unknown): Severities {
  const count: Severities = { critical: 0, high: 0, medium: 0, low: 0 };
  const results = record(json).Results;
  for (const result of Array.isArray(results) ? results.map(record) : []) {
    const vulnerabilities = Array.isArray(result.Vulnerabilities)
      ? result.Vulnerabilities.map(record)
      : [];
    for (const vulnerability of vulnerabilities) {
      const severity = String(vulnerability.Severity).toLowerCase();
      if (severity in count) count[severity as keyof Severities] += 1;
    }
  }
  return count;
}

const all = files(INPUT);
const named = (name: string) => all.filter((path) => basename(path) === name);

const isVitest = (json: Record<string, unknown>) =>
  "numTotalTests" in json && "testResults" in json;
const isPlaywright = (json: Record<string, unknown>) =>
  "stats" in json && "suites" in json;

const suites: SuiteResult[] = [];
for (const [key, label] of Object.entries(SUITES)) {
  const json = all
    .filter((p) => basename(p) === `${key}.json`)
    .map((p) => record(readJson(p)))
    .find((j) => isVitest(j) || isPlaywright(j));
  if (!json) continue;
  const result = isPlaywright(json) ? playwrightSuite(json) : vitestSuite(json);
  suites.push({ ...label, ...result });
}
const rustLog = named("unit-tests.log")[0];
const rust = rustLog ? rustSuite(readFileSync(rustLog, "utf8")) : undefined;
if (rust) suites.splice(Math.min(suites.length, 8), 0, rust);

function lcovLines(path: string): { covered: number; total: number } | null {
  if (!existsSync(path)) return null;
  let covered = 0;
  let total = 0;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (line.startsWith("LH:")) covered += Number(line.slice(3));
    if (line.startsWith("LF:")) total += Number(line.slice(3));
  }
  return total > 0 ? { covered, total } : null;
}

const coverageReports: [from: string, to: string][] = [];
const coverage = named("coverage-summary.json")
  .flatMap((path): Coverage[] => {
    const summary = coverageOf(path);
    if (!summary || !(summary.part in COVERAGE_PARTS)) return [];
    const folder = dirname(path);
    const lcov = lcovLines(join(folder, "lcov.info"));
    const html = join(folder, summary.part === "rust" ? "html" : "lcov-report");
    const report = existsSync(join(html, "index.html"))
      ? `coverage/${summary.part}/index.html`
      : null;
    if (report)
      coverageReports.push([html, join(OUTPUT, "coverage", summary.part)]);
    return [
      {
        ...summary,
        coveredLines: lcov?.covered ?? null,
        totalLines: lcov?.total ?? null,
        report,
      },
    ];
  })
  .sort((a, b) => b.lines - a.lines);

const gitleaksPath = named("gitleaks.json")[0];
const leaks = gitleaksPath
  ? (readJson(gitleaksPath) as unknown[] | undefined)
  : undefined;
const semgrepPath = named("semgrep.json")[0];
const semgrep = semgrepPath ? record(readJson(semgrepPath)) : undefined;
const semgrepResults =
  semgrep && Array.isArray(semgrep.results)
    ? semgrep.results.map(record)
    : undefined;
const semgrepBy = (severity: string) =>
  (semgrepResults ?? []).filter((r) => record(r.extra).severity === severity)
    .length;
const semgrepRules = [
  ...new Set(
    (semgrepResults ?? []).map((r) =>
      String(r.check_id).split(".").slice(-2).join("."),
    ),
  ),
];
const depsPath = named("trivy-deps.json")[0];
const deps = depsPath ? severities(readJson(depsPath)) : undefined;
const imagePaths = all.filter((p) =>
  /^trivy-(?!deps).+\.json$/.test(basename(p)),
);
const images = imagePaths.map((p) => ({
  name: basename(p).slice(6, -5),
  ...severities(readJson(p)),
}));

const jobsJson = record(
  process.env.QA_JOBS ? (JSON.parse(process.env.QA_JOBS) as unknown) : {},
);
const jobResult = (key: string): Status => {
  const result = record(jobsJson[key]).result;
  if (result === undefined) return "not-run";
  return result === "success"
    ? "pass"
    : result === "skipped"
      ? "not-run"
      : "fail";
};

const totals = suites.reduce(
  (sum, s) => ({
    passed: sum.passed + s.passed,
    failed: sum.failed + s.failed,
    skipped: sum.skipped + s.skipped,
  }),
  { passed: 0, failed: 0, skipped: 0 },
);
const inCi = process.env.GITHUB_ACTIONS === "true";
const allJobsPassed = JOBS.every(([key]) => jobResult(key) === "pass");
const highOrCritical =
  (deps ? deps.high + deps.critical : 0) +
  images.reduce((sum, i) => sum + i.high + i.critical, 0);
const verdict: Status =
  totals.failed > 0 ||
  (inCi && !allJobsPassed) ||
  (leaks?.length ?? 0) > 0 ||
  semgrepBy("ERROR") > 0
    ? "fail"
    : inCi && allJobsPassed && suites.length > 0
      ? "pass"
      : "info";

const repository = process.env.GITHUB_REPOSITORY ?? "";
const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
const runId = process.env.GITHUB_RUN_ID;
const commit = (process.env.GITHUB_SHA ?? "local").slice(0, 7);
const runUrl =
  runId && repository
    ? `${server}/${repository}/actions/runs/${runId}`
    : undefined;
const generated =
  new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const fmt = (n: number) => n.toLocaleString("en-US");
const pct = (n: number | null) => (n === null ? "n/a" : `${n.toFixed(1)}%`);
const LABEL: Record<Status, string> = {
  pass: "Pass",
  fail: "Fail",
  "not-run": "Not run",
  info: "Info",
};
const pill = (status: Status, text = LABEL[status]) =>
  `<span class="pill ${status}">${escape(text)}</span>`;
const table = (headers: string[], rows: string[][], footer?: string[]) =>
  `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join(
      "",
    )}</tbody>${footer ? `<tfoot><tr>${footer.map((c) => `<td>${c}</td>`).join("")}</tr></tfoot>` : ""}</table></div>`;
const list = (items: string[]) =>
  `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
const sev = (s: Severities) =>
  `${s.critical} critical, ${s.high} high, ${s.medium} medium, ${s.low} low`;
const bar = (value: number) =>
  `<div class="bar"><div class="track"><div class="fill${value < 50 ? " low" : ""}" style="width:${Math.min(100, value).toFixed(1)}%"></div></div><span class="v">${pct(value)}</span></div>`;

const objectiveRows: string[][] = [
  [
    "Reliability",
    "Every change passes the whole pipeline before it reaches users",
    inCi
      ? pill(allJobsPassed ? "pass" : "fail", allJobsPassed ? "Met" : "Not met")
      : pill("not-run"),
  ],
  [
    "Reliability",
    "No automated test fails or is skipped to pass",
    suites.length
      ? pill(
          totals.failed === 0 ? "pass" : "fail",
          totals.failed === 0 ? "Met" : "Not met",
        )
      : pill("not-run"),
  ],
  [
    "Reliability",
    "Data encrypted by earlier versions still decrypts",
    pill(
      jobResult("compatibility"),
      jobResult("compatibility") === "pass"
        ? "Met"
        : LABEL[jobResult("compatibility")],
    ),
  ],
  [
    "Security",
    "No secret committed to the Git history",
    leaks
      ? pill(
          leaks.length === 0 ? "pass" : "fail",
          leaks.length === 0 ? "Met" : "Not met",
        )
      : pill("not-run"),
  ],
  [
    "Security",
    "No high or critical vulnerability open in dependencies or images",
    deps || images.length
      ? pill(
          highOrCritical === 0 ? "pass" : "fail",
          highOrCritical === 0 ? "Met" : "Not met",
        )
      : pill("not-run"),
  ],
  [
    "Maintainability",
    "Consistent, strictly typed code with no lint errors",
    pill(
      jobResult("lint") === "pass" && jobResult("typecheck") === "pass"
        ? "pass"
        : jobResult("lint") === "not-run"
          ? "not-run"
          : "fail",
      jobResult("lint") === "pass" && jobResult("typecheck") === "pass"
        ? "Met"
        : undefined,
    ),
  ],
  [
    "Defect reduction",
    "Security-critical code (gateway, SDK, identity, Rust services) above 80% line coverage",
    coverage.length
      ? (() => {
          const key = coverage.filter((c) =>
            ["gateway", "sdk", "identity", "rust"].includes(c.part),
          );
          const ok = key.length > 0 && key.every((c) => c.lines >= 80);
          return pill(ok ? "pass" : "fail", ok ? "Met" : "Not met");
        })()
      : pill("not-run"),
  ],
];

const staticRows: string[][] = [
  [
    "ESLint (type-checked rules), Prettier",
    "Bugs, unsafe patterns and formatting in TypeScript, JSON, YAML and Markdown",
    pill(jobResult("lint")),
  ],
  [
    "rustfmt and clippy (warnings are errors)",
    "Rust formatting and lints",
    pill(jobResult("lint")),
  ],
  [
    "TypeScript compiler (strict, no any)",
    "Types in every package",
    pill(jobResult("typecheck")),
  ],
  [
    "Gitleaks",
    `Secrets anywhere in the Git history: ${leaks ? `${leaks.length} found` : "no report"}`,
    pill(jobResult("secret-scan")),
  ],
  [
    "Semgrep",
    semgrepResults
      ? `Insecure code patterns: ${semgrepBy("ERROR")} at ERROR (these fail the build), ${semgrepBy("WARNING")} warning, ${semgrepBy("INFO")} info${semgrepRules.length ? ` (${escape(semgrepRules.join(", "))})` : ""}`
      : "Insecure code patterns: no report",
    pill(jobResult("code-scan")),
  ],
  [
    "Trivy, dependencies",
    deps ? `pnpm-lock.yaml: ${sev(deps)}` : "pnpm-lock.yaml: no report",
    pill(jobResult("dependency-scan")),
  ],
  [
    "Trivy, images",
    images.length
      ? images.map((i) => `${escape(i.name)}: ${sev(i)}`).join("<br>")
      : "Built images: no report",
    pill(jobResult("image-scan")),
  ],
  [
    "cargo audit",
    "Known vulnerabilities in Rust crates",
    pill(jobResult("rust-audit")),
  ],
  [
    "oasdiff",
    "Breaking changes to the public /v1 API, compared with main",
    pill(jobResult("api-breaking-changes")),
  ],
  [
    "drizzle-kit check",
    "Migrations consistent with the schemas",
    pill(jobResult("migrations")),
  ],
];

const gateRows = JOBS.map(([key, name]) => [
  escape(name),
  pill(jobResult(key)),
]);

const suiteRows = suites.map((s) => [
  escape(s.name),
  escape(s.level),
  `<span class="num">${fmt(s.passed)}</span>`,
  `<span class="num">${fmt(s.failed)}</span>`,
  `<span class="num">${fmt(s.skipped)}</span>`,
  `<span class="num">${s.durationMs === null ? "–" : `${(s.durationMs / 1000).toFixed(0)} s`}</span>`,
  pill(s.failed === 0 ? "pass" : "fail"),
]);

const coverageRows = coverage.map((c) => [
  escape(COVERAGE_PARTS[c.part] ?? c.part),
  bar(c.lines),
  `<span class="num">${c.totalLines === null ? "–" : `${fmt(c.coveredLines ?? 0)} of ${fmt(c.totalLines)}`}</span>`,
  `<span class="num">${pct(c.statements)}</span>`,
  `<span class="num">${pct(c.functions)}</span>`,
  `<span class="num">${pct(c.branches)}</span>`,
  c.report
    ? `<a href="${escape(c.report)}">Line by line</a>`
    : `<span class="muted">–</span>`,
]);

const missing = [
  suites.length === 0 && "test results",
  coverage.length === 0 && "coverage",
  !semgrepResults && "the Semgrep report",
  !leaks && "the Gitleaks report",
  !inCi && "the pipeline's job results (this page was built outside CI)",
].filter((m): m is string => typeof m === "string");

const VERDICT_TEXT: Record<Status, string> = {
  pass: "All quality gates passed.",
  fail: "At least one quality gate failed.",
  "not-run": "Not run.",
  info: "Partial report: not every result was available.",
};

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>secure-cloud QA report</title>
<style>
:root{--bg:#f6f7f9;--surface:#fff;--surface-2:#eef0f3;--text:#16181d;--muted:#5b616e;--border:#dde1e7;--accent:#1f4fd1;--pass:#137333;--pass-bg:#e6f4ea;--fail:#b3261e;--fail-bg:#fce8e6;--info:#1a56b8;--info-bg:#e7effc;--idle:#5b616e;--idle-bg:#eceef1;--bar:#2f6fed;--bar-low:#d08a00}
@media (prefers-color-scheme:dark){:root{--bg:#111317;--surface:#191c21;--surface-2:#22262d;--text:#e8eaee;--muted:#a0a6b2;--border:#2f343c;--accent:#7aa2ff;--pass:#81c995;--pass-bg:#13301d;--fail:#f28b82;--fail-bg:#3c1614;--info:#8ab4f8;--info-bg:#142540;--idle:#a0a6b2;--idle-bg:#2a2e35;--bar:#7aa2ff;--bar-low:#f2c66d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
main{max-width:1080px;margin:0 auto;padding:32px 16px 64px}h1{font-size:30px;margin:0 0 4px}h2{font-size:21px;margin:40px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--border)}h3{font-size:17px;margin:24px 0 8px}
p{margin:0 0 10px}a{color:var(--accent)}code{font:13px ui-monospace,Consolas,monospace;background:var(--surface-2);padding:1px 5px;border-radius:4px}
.muted{color:var(--muted)}.small{font-size:13px}header{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px}
.meta{display:flex;flex-wrap:wrap;gap:6px 24px;margin-top:12px;font-size:13px;color:var(--muted)}
.verdict{display:flex;gap:12px;align-items:flex-start;margin-top:18px;padding:14px 16px;border-radius:10px;background:var(--surface-2)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-top:16px}.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px}.card .n{font-size:26px;font-weight:700}.card .l{font-size:13px;color:var(--muted)}
.table-wrap{overflow-x:auto;background:var(--surface);border:1px solid var(--border);border-radius:10px}table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--border);vertical-align:top}th{background:var(--surface-2);font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}tr:last-child td{border-bottom:0}tfoot td{font-weight:700;background:var(--surface-2)}
.num{font-variant-numeric:tabular-nums;white-space:nowrap}
.pill{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}.pass{background:var(--pass-bg);color:var(--pass)}.fail{background:var(--fail-bg);color:var(--fail)}.info{background:var(--info-bg);color:var(--info)}.not-run{background:var(--idle-bg);color:var(--idle)}
.bar{display:flex;align-items:center;gap:8px;min-width:150px}.bar .track{flex:1;height:8px;background:var(--surface-2);border-radius:999px;overflow:hidden}.bar .fill{height:100%;background:var(--bar)}.bar .fill.low{background:var(--bar-low)}.bar .v{width:52px;text-align:right;font-variant-numeric:tabular-nums}
ul{margin:0 0 10px;padding-left:20px}li{margin:3px 0}.note{background:var(--surface);border:1px solid var(--border);border-left:4px solid var(--accent);border-radius:8px;padding:12px 14px;margin:12px 0}
@media print{body{background:#fff}}
</style>
</head>
<body>
<main>
<header>
<p class="muted small" style="margin:0">Quality assurance report, built by the CI/CD pipeline</p>
<h1>secure-cloud</h1>
<p class="muted" style="margin:0">A secure cloud platform for developers' apps: API gateway, secrets manager, encrypted storage, connections, webhooks, user pools, feature flags and audit log.</p>
<div class="meta">
<span><strong>Commit:</strong> <code>${escape(commit)}</code>${process.env.GITHUB_REF_NAME ? ` on <code>${escape(process.env.GITHUB_REF_NAME)}</code>` : ""}</span>
<span><strong>Pipeline run:</strong> ${runUrl ? `<a href="${escape(runUrl)}">${escape(runId ?? "")}</a>` : "built locally"}</span>
<span><strong>Generated:</strong> ${generated}</span>
</div>
<div class="verdict" role="status">${pill(verdict, verdict === "pass" ? "PASS" : verdict === "fail" ? "FAIL" : "PARTIAL")}<div><strong>${VERDICT_TEXT[verdict]}</strong>${missing.length ? `<br><span class="muted small">Missing from this run: ${escape(missing.join("; "))}.</span>` : ""}</div></div>
</header>
<div class="cards" aria-label="Key figures">
<div class="card"><div class="n">${fmt(totals.passed)}</div><div class="l">automated tests passed</div></div>
<div class="card"><div class="n">${fmt(totals.failed)}</div><div class="l">tests failed</div></div>
<div class="card"><div class="n">${inCi ? `${JOBS.filter(([k]) => jobResult(k) === "pass").length} / ${JOBS.length}` : "–"}</div><div class="l">pipeline checks passed</div></div>
<div class="card"><div class="n">${deps || images.length ? fmt(highOrCritical) : "–"}</div><div class="l">high or critical vulnerabilities</div></div>
<div class="card"><div class="n">${leaks ? fmt(leaks.length) : "–"}</div><div class="l">secrets found in Git history</div></div>
</div>

<h2>9. Quality Assurance</h2>
<h3>9.1 Quality Objectives</h3>
<p>Each objective is checked automatically on every run; the status below is this run's.</p>
${table(["Goal", "Objective", "This run"], objectiveRows)}

<h3>9.2 Coding Standards</h3>
${list([
  "<strong>Naming:</strong> TypeScript files and folders in kebab-case (<code>api-key.service.ts</code>), types in PascalCase, functions and variables in camelCase; Rust in snake_case with CamelCase types.",
  "<strong>Structure:</strong> every service has the same layers, called in order only: routes → controllers → services → models; all database access is in models.",
  "<strong>Style guides:</strong> strict TypeScript (never <code>any</code>), ESLint with type-checked rules, Prettier, rustfmt and clippy; LF line endings everywhere.",
  "<strong>Comments:</strong> none in code; names and small functions explain it, and explanations go in the docs and the architecture decision records. Only comments tools need are allowed.",
  "<strong>API standards:</strong> one error format with stable codes and a request ID; the public API is versioned (<code>/v1</code>) with an OpenAPI contract.",
  "<strong>Documentation:</strong> a README, an API guide, a runbook, 40 architecture decision records, and a changelog for every API change.",
])}

<h3>9.3 Static Analysis</h3>
${table(["Tool", "What it checks, and this run's result", "Status"], staticRows)}

<h3>9.4 Quality Gates</h3>
<p>A pull request can merge only when the required check <em>All checks passed</em> succeeds, and it succeeds only when every gate below passes. A gate that didn't run is never counted as passed.</p>
${table(["Gate (pipeline job)", "This run"], gateRows)}

<h2>10. Agile Test Plan</h2>
<h3>10.1 Test Objectives</h3>
${list([
  "Prove every feature works, at the lowest level that can show it, and the main user journeys end to end.",
  "Prove the security rules: tenant isolation (another workspace's data is the same 404 as missing data), write-only secrets, nothing sensitive in logs or errors, sealed behaviour, SSRF blocking, rate and policy limits.",
  "Keep the contracts between services and the public API stable.",
  "Keep every page accessible (axe) and usable on desktop and phone widths.",
  "Quality goal: every test passes on every change; a flaky test is fixed at its cause, never skipped.",
])}

<h3>10.2 Test Scope</h3>
${table(
  ["Included", "Excluded"],
  [
    [
      list([
        "Unit and contract tests for every service, the SDK, the dashboard and the demo shop",
        "Database separation and migrations",
        "Encryption compatibility with earlier versions",
        "End-to-end tests against the whole Docker stack",
        "Browser tests with accessibility checks, including a real Stripe test checkout",
        "Static analysis and security scans",
      ]),
      list([
        "Load and performance testing beyond the streaming memory test",
        "Third-party penetration testing",
        "Browsers other than Chromium",
        "Stripe live mode",
      ]),
    ],
  ],
)}

<h3>10.3 Test Environment</h3>
${table(
  ["Environment", "Details"],
  [
    [
      "This run",
      inCi
        ? `GitHub Actions, ${escape(process.env.RUNNER_OS ?? "Linux")} runner (${escape(process.env.ImageOS ?? "ubuntu-latest")}), Node.js ${escape(process.version)}`
        : `Built locally with Node.js ${escape(process.version)}`,
    ],
    [
      "Unit and contract",
      "Vitest with an in-memory PostgreSQL (PGlite); Rust tests with a PostgreSQL 18 service container",
    ],
    [
      "End-to-end and browser",
      "The whole stack in Docker Compose, built from the commit, with secrets generated for the run; Playwright with Chromium",
    ],
    [
      "Production",
      "One AWS EC2 server (t3.small, 30 GB disk), Docker Compose, Caddy with Let's Encrypt, images from Amazon ECR",
    ],
  ],
)}

<h3>10.4 Test Execution</h3>
${suites.length ? table(["Suite", "Level", "Passed", "Failed", "Skipped", "Time", "Result"], suiteRows, ["Total", "", `<span class="num">${fmt(totals.passed)}</span>`, `<span class="num">${fmt(totals.failed)}</span>`, `<span class="num">${fmt(totals.skipped)}</span>`, "", pill(totals.failed === 0 ? "pass" : "fail")]) : `<p>${pill("not-run")} No test results were available to this report.</p>`}

<h3>10.5 Code Coverage</h3>
${coverage.length ? table(["Part", "Lines", "Lines covered (lcov)", "Statements", "Functions", "Branches", "Report"], coverageRows) : `<p>${pill("not-run")} No coverage report was available to this report.</p>`}
<div class="note">The dashboard and demo shop pages run in the browser, so their journeys are covered by the browser tests in 10.4, which unit coverage doesn't count; their unit figures only cover logic such as the API client, redirects, sessions and messages. Rust statements are LLVM regions, and Rust branch coverage needs a nightly compiler, so it shows n/a. Coverage is recorded in the standard lcov format (<code>lcov.info</code> per part): the covered-lines column is read from it, and each part's line-by-line lcov report is linked in the last column.</div>

<p class="muted small" style="margin-top:32px">Every figure on this page comes from the pipeline run shown at the top: its test result files, coverage summaries, scan reports and job results.</p>
</main>
</body>
</html>
`;

mkdirSync(OUTPUT, { recursive: true });
writeFileSync(join(OUTPUT, "index.html"), html);
for (const [from, to] of coverageReports) cpSync(from, to, { recursive: true });
console.log(
  `QA report: ${join(OUTPUT, "index.html")} (${VERDICT_TEXT[verdict]} ${fmt(totals.passed)} tests passed, ${fmt(totals.failed)} failed)`,
);
