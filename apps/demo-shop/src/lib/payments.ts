import { viaConnection } from "./platform/client";

export const PAYMENTS_CONNECTION = "payments";

export type ChargeResult =
  | { ok: true; chargeId: string }
  | { ok: false; reason: "declined" | "provider_error"; status: number };

export async function charge(
  amountCents: number,
  description: string,
): Promise<ChargeResult> {
  const response = await viaConnection<{ id?: unknown }>(
    PAYMENTS_CONNECTION,
    "POST /charges",
    { amount: amountCents, currency: "sgd", description },
  );
  if (response.status === 201 && typeof response.data.id === "string") {
    return { ok: true, chargeId: response.data.id };
  }
  return {
    ok: false,
    reason: response.status === 402 ? "declined" : "provider_error",
    status: response.status,
  };
}
