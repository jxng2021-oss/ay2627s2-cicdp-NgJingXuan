# Quality assurance

Everything about how secure-cloud's quality is measured and reported lives
here. The live report, rebuilt from every run on `main`, is at
https://jxng2021-oss.github.io/ay2627s2-cicdp-NgJingXuan/.

| Path                  | What it is                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `report.ts`           | Builds the QA report (`pnpm qa:report`): one self-contained HTML page following report sections 9 and 10 |
| `coverage-summary.ts` | Prints the coverage table at the end of `pnpm test:coverage` (and in the CI run's summary)               |
| `results/`            | Test results written by every suite: Vitest and Playwright JSON, and the unit job's log for Rust         |
| `coverage/`           | Coverage per part: `lcov.info`, the line-by-line lcov HTML report and a JSON summary                     |
| `scans/`              | Gitleaks, Semgrep and Trivy reports from `pnpm scan:*`                                                   |
| `report/`             | The built report, with each part's lcov report under `coverage/`                                         |

`results/`, `coverage/`, `scans/` and `report/` are generated and never
committed.

## Building the report locally

```sh
pnpm test:coverage   # results and coverage (the Rust tests need a PostgreSQL DATABASE_URL)
pnpm test:database
pnpm scan:secrets && pnpm scan:code && pnpm scan:deps
pnpm qa:report       # writes qa/report/index.html
```

Built outside CI, the page says it is partial, because the pipeline's job
results are missing; anything that didn't run is shown as not run, never as
passed.

## In the pipeline

Every job writes its results here and keeps them as artifacts. Job **6. QA
report** downloads them all, runs `pnpm qa:report` with the jobs' results and
keeps the page as an artifact; on `main`, job **7** publishes it on GitHub
Pages. See [ADR 0041](../docs/decisions/0041-qa-report-on-github-pages.md).
