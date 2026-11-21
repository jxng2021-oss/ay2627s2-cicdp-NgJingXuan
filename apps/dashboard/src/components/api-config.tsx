"use client";

import { configureApiOrigin } from "@/lib/api/origin";

export function ApiConfig({ origin }: { origin: string }) {
  configureApiOrigin(origin);
  return null;
}
