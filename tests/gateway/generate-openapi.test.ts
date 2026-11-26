import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalArgv = process.argv;
let written: string[];

beforeEach(() => {
  vi.resetModules();
  written = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  process.argv = originalArgv;
});

async function generate(document?: string): Promise<Record<string, unknown>> {
  process.argv = [
    "node",
    "generate-openapi.js",
    ...(document ? [document] : []),
  ];
  await import("../../services/gateway/src/generate-openapi.js");
  return JSON.parse(written.join("")) as Record<string, unknown>;
}

const committed = (file: string) =>
  JSON.parse(
    readFileSync(new URL(`../../api/${file}`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;

describe("generating the OpenAPI documents", () => {
  it("prints the public API document, matching the committed one", async () => {
    const spec = await generate();
    expect(spec).toEqual(committed("openapi.v1.json"));
    expect(
      Object.keys(spec.paths as object).every(
        (path) => !path.startsWith("/dashboard/"),
      ),
    ).toBe(true);
  });

  it("prints the dashboard document, matching the committed one", async () => {
    const spec = await generate("dashboard");
    expect(spec).toEqual(committed("openapi.dashboard.json"));
    expect(
      Object.keys(spec.paths as object).every((path) =>
        path.startsWith("/dashboard/"),
      ),
    ).toBe(true);
  });
});
