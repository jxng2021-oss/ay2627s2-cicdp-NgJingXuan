# 0041: A QA report built by the pipeline and published on GitHub Pages

- Status: Accepted
- Date: 2026-11-25

## Context

The pipeline already proves each change with tests, coverage and scans, but
the results were spread over job logs and artifacts that expire, and a
hand-written report would go out of date with the next merge. The project
needs one page showing how the current release was tested, in the structure
of the report's quality sections (9.1 to 9.4 and 10.1 to 10.5), that anyone
can open without a GitHub account.

## Decision

- **The results become files.** Every Vitest suite writes a JSON result to
  `qa/results/` next to its normal output, the Playwright suites do the
  same, and the unit job keeps its log for the Rust results. The scans already
  write JSON reports. Coverage is written in the standard **lcov** format
  (`lcov.info` and its HTML report per part, from Vitest and cargo-llvm-cov)
  next to its JSON summary.
- **A root script builds the page.** `pnpm qa:report` (`qa/report.ts`)
  reads whatever result files it finds and the pipeline's job results, and
  writes one self-contained HTML page (no outside scripts, styles or images,
  with a Content Security Policy that allows none). Anything missing is shown
  as not run, never as passed; built outside CI, the page says it is partial.
  The covered-lines figures are read from `lcov.info`, and each part's
  line-by-line lcov report is published with the page and linked from it.
- **The pipeline runs it on every run** (job 6, after the required check, even
  when a job failed) and keeps the page as an artifact. On `main` only, job 7
  publishes it to GitHub Pages with `actions/deploy-pages`.
- **Least privilege.** Only the publishing job gets `pages: write` and
  `id-token: write`; it runs in the `github-pages` environment and one
  deployment at a time. Every other job keeps the read-only default.

## Consequences

- The live report always describes the latest release on `main`, with its
  commit and a link to the run that built it.
- A failing run on `main` publishes a failing report rather than hiding it.
- GitHub Pages must be enabled once with **GitHub Actions** as its source.
- The report adds about a minute to each run.
