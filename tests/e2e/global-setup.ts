import type { TestProject } from "vitest/node";
import { prepareSecrets } from "./operator.js";

export default async function setup(project: TestProject): Promise<void> {
  project.provide("unsealShares", await prepareSecrets());
}

declare module "vitest" {
  export interface ProvidedContext {
    unsealShares: string[];
  }
}
