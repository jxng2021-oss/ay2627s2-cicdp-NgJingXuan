import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dockerRun, REPO } from "./docker.ts";

const GITLEAKS_IMAGE =
  "ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f";
const SEMGREP_IMAGE =
  "semgrep/semgrep:1.181.0@sha256:81474464c1f07483ba0682a44787fd93c91397419762a04abe2bafaae396304b";
const TRIVY_IMAGE =
  "aquasec/trivy:0.76.0@sha256:2416d1f74045b57274df1a340eee6b510cacd73c66a6ccb8da092b117eb7d222";

const SEMGREP_RULESETS = [
  "p/typescript",
  "p/nodejs",
  "p/dockerfile",
  "p/docker-compose",
  "p/github-actions",
  "p/rust",
];

const APP_IMAGES = [
  "secure-cloud-platform/gateway:dev",
  "secure-cloud-platform/storage:dev",
  "secure-cloud-platform/secrets:dev",
  "secure-cloud-platform/audit:dev",
  "secure-cloud-platform/identity:dev",
  "secure-cloud-platform/flags:dev",
  "secure-cloud-platform/dashboard:dev",
];

const REPORTS_DIR = "qa/scans";
const CACHE_DIR = ".cache";

type Scan = "secrets" | "code" | "deps" | "images";
const SCANS: Record<Scan, () => boolean> = {
  secrets: scanSecrets,
  code: scanCode,
  deps: scanDependencies,
  images: scanImages,
};

function main(): void {
  const scan = process.argv[2];
  if (!isScan(scan)) {
    console.error(
      `Usage: node scripts/security-scan.ts <${Object.keys(SCANS).join("|")}>`,
    );
    process.exit(2);
  }
  mkdirSync(join(REPO, REPORTS_DIR), { recursive: true });
  mkdirSync(join(REPO, CACHE_DIR, "trivy"), { recursive: true });

  const passed = SCANS[scan]();
  console.log(passed ? `\n✔ ${scan} scan passed` : `\n✘ ${scan} scan FAILED`);
  process.exit(passed ? 0 : 1);
}

function isScan(value: string | undefined): value is Scan {
  return value !== undefined && value in SCANS;
}

function scanSecrets(): boolean {
  const reportPath = `${REPORTS_DIR}/gitleaks.json`;
  const exitCode = dockerRun(GITLEAKS_IMAGE, [
    "git",
    "--config=/src/.gitleaks.toml",
    "--redact",
    "--verbose",
    "--no-banner",
    "--report-format=json",
    `--report-path=${reportPath}`,
    "/src",
  ]);

  const findings = readJson<GitleaksFinding[]>(reportPath) ?? [];
  const safe = findings.map(
    ({ RuleID, Description, File, StartLine, Commit }) => ({
      RuleID,
      Description,
      File,
      StartLine,
      Commit,
    }),
  );
  writeFileSync(join(REPO, reportPath), JSON.stringify(safe, null, 2));

  return exitCode === 0;
}

function scanCode(): boolean {
  const reportPath = `${REPORTS_DIR}/semgrep.json`;
  const exitCode = dockerRun(SEMGREP_IMAGE, [
    "semgrep",
    "scan",
    "--metrics=off",
    "--disable-version-check",
    ...SEMGREP_RULESETS.flatMap((ruleset) => ["--config", ruleset]),
    "--text",
    `--json-output=${reportPath}`,
  ]);
  if (exitCode !== 0) return false;

  const report = readJson<SemgrepReport>(reportPath);
  if (!report) return false;

  for (const result of report.results) delete result.extra.lines;
  writeFileSync(join(REPO, reportPath), JSON.stringify(report, null, 2));

  const blocking = report.results.filter((r) => r.extra.severity === "ERROR");
  console.log(
    `\nSemgrep: ${report.results.length} finding(s), ${blocking.length} at ERROR severity (these fail the build).`,
  );
  for (const r of blocking)
    console.log(`  ${r.path}:${r.start.line}  ${r.check_id}`);
  return blocking.length === 0;
}

function scanDependencies(): boolean {
  return runTrivy("dependencies", "trivy-deps.json", [
    "fs",
    "--include-dev-deps",
    "--skip-dirs=**/node_modules",
    "--skip-dirs=**/target",
    "/src",
  ]);
}

function scanImages(): boolean {
  let passed = true;
  for (const image of APP_IMAGES) {
    const name = image.split("/")[1]?.split(":")[0] ?? "image";
    const tarPath = `${CACHE_DIR}/${name}.tar`;
    const saved = spawnSync(
      "docker",
      ["save", image, "-o", join(REPO, tarPath)],
      {
        stdio: "inherit",
      },
    );
    if (saved.status !== 0) {
      console.error(
        `Could not save ${image}. Build it first with: pnpm docker:build`,
      );
      return false;
    }
    const imagePassed = runTrivy(image, `trivy-${name}.json`, [
      "image",
      `--input=/src/${tarPath}`,
    ]);
    rmSync(join(REPO, tarPath), { force: true });
    passed &&= imagePassed;
  }
  return passed;
}

function runTrivy(label: string, reportFile: string, args: string[]): boolean {
  const reportPath = `${REPORTS_DIR}/${reportFile}`;
  const common = [
    "--cache-dir=/src/.cache/trivy",
    "--no-progress",
    "--skip-version-check",
  ];

  const scanned = dockerRun(TRIVY_IMAGE, [
    ...args.slice(0, 1),
    ...common,
    "--scanners=vuln",
    "--format=json",
    `--output=${reportPath}`,
    ...args.slice(1),
  ]);
  if (scanned !== 0) return false;

  console.log(`\nAll vulnerabilities in ${label} (shown for information):`);
  dockerRun(TRIVY_IMAGE, [
    "convert",
    "--format=table",
    "--table-mode=detailed",
    reportPath,
  ]);

  const report = readJson<TrivyReport>(reportPath);
  if (!report) return false;
  const blocking = (report.Results ?? [])
    .flatMap((result) => result.Vulnerabilities ?? [])
    .filter(
      (v) =>
        (v.Severity === "HIGH" || v.Severity === "CRITICAL") && v.FixedVersion,
    );

  console.log(
    `\n${label}: ${blocking.length} HIGH/CRITICAL vulnerabilit${blocking.length === 1 ? "y" : "ies"} with a fix available (these fail the build).`,
  );
  for (const v of blocking) {
    console.log(
      `  ${v.Severity} ${v.VulnerabilityID} ${v.PkgName} ${v.InstalledVersion} -> ${v.FixedVersion}`,
    );
  }
  return blocking.length === 0;
}

function readJson<T>(relativePath: string): T | undefined {
  try {
    return JSON.parse(readFileSync(join(REPO, relativePath), "utf8")) as T;
  } catch {
    console.error(`Could not read report ${relativePath}`);
    return undefined;
  }
}

interface GitleaksFinding {
  RuleID: string;
  Description: string;
  File: string;
  StartLine: number;
  Commit: string;
}

interface SemgrepReport {
  results: {
    check_id: string;
    path: string;
    start: { line: number };
    extra: { severity: string; lines?: string };
  }[];
}

interface TrivyReport {
  Results?: {
    Target: string;
    Vulnerabilities?: {
      VulnerabilityID: string;
      PkgName: string;
      InstalledVersion: string;
      FixedVersion?: string;
      Severity: string;
    }[];
    Misconfigurations?: {
      ID: string;
      Title: string;
      Severity: string;
      Status: string;
    }[];
  }[];
}

main();
