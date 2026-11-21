const ORIGIN_PATTERN = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/;

export function apiOriginFromEnv(): string {
  const origin = process.env.DASHBOARD_API_ORIGIN ?? "http://localhost:8080";
  if (!ORIGIN_PATTERN.test(origin)) {
    throw new Error(
      "DASHBOARD_API_ORIGIN must be an origin like https://api.example.com (no path or trailing slash)",
    );
  }
  return origin;
}

let configured = "";

export function configureApiOrigin(origin: string): void {
  configured = origin;
}

export function apiUrl(path: string): string {
  return configured + path;
}
