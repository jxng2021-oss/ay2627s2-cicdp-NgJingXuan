export const POLICY_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;
export type PolicyMethod = (typeof POLICY_METHODS)[number];

export interface AllowedRoute {
  method: PolicyMethod;
  path: string;
}

export interface ConnectionPolicy {
  allowedRoutes?: AllowedRoute[];
  rateLimit?: { requests: number; windowSeconds: number };
  amountLimit?: { field: string; maxPerRequest: number; maxPerDay: number };
}

export const AMOUNT_METHODS = new Set(["POST", "PUT", "PATCH"]);

export const MAX_AMOUNT_BODY_BYTES = 16 * 1024;

export type DenialReason =
  | "route_not_allowed"
  | "amount_missing"
  | "amount_too_high"
  | "daily_limit_reached";

export const DENIAL_MESSAGES: Record<DenialReason, string> = {
  route_not_allowed:
    "The connection's policy doesn't allow this method and path",
  amount_missing:
    "The connection's policy needs a whole, positive amount in the JSON or form body",
  amount_too_high: "The amount is over the connection's per-call limit",
  daily_limit_reached: "The amount would go over the connection's daily limit",
};

export function policyProblem(policy: ConnectionPolicy): string | undefined {
  const routes = policy.allowedRoutes;
  if (routes) {
    const seen = new Set<string>();
    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      if (seen.has(key)) return `policy.allowedRoutes lists ${key} twice`;
      seen.add(key);
    }
  }
  const amount = policy.amountLimit;
  if (amount && amount.maxPerDay < amount.maxPerRequest) {
    return "policy.amountLimit.maxPerDay can't be less than maxPerRequest";
  }
  return undefined;
}

function segments(path: string): string[] {
  const plain = path.split("?")[0] ?? "";
  return plain.split("/").filter((part) => part !== "");
}

export function routeAllowed(
  policy: ConnectionPolicy,
  method: string,
  path: string,
): boolean {
  if (!policy.allowedRoutes) return true;
  const asked = method === "HEAD" ? "GET" : method;
  const parts = segments(path);
  return policy.allowedRoutes.some((route) => {
    if (route.method !== asked) return false;
    const pattern = segments(route.path);
    return (
      pattern.length === parts.length &&
      pattern.every((part, i) => part === "*" || part === parts[i])
    );
  });
}

const positiveWhole = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;

export function amountFrom(
  body: Buffer,
  field: string,
  contentType = "application/json",
): number | undefined {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  if (type === "application/x-www-form-urlencoded") {
    const values = new URLSearchParams(body.toString("utf8")).getAll(field);
    return values.length === 1 && /^[1-9][0-9]{0,15}$/.test(values[0]!)
      ? positiveWhole(Number(values[0]))
      : undefined;
  }
  if (type !== "application/json") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return positiveWhole((parsed as Record<string, unknown>)[field]);
}

export function utcDay(now = new Date()): { day: string; endsAtMs: number } {
  const day = now.toISOString().slice(0, 10);
  const end = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return { day, endsAtMs: end };
}

export function policyKeys(tenantId: string, connection: string, day: string) {
  return {
    calls: `policy:calls:${tenantId}:${connection}`,
    amount: `policy:amount:${tenantId}:${connection}:${day}`,
  };
}
