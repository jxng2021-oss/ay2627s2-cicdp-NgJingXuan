import { PlatformError } from "./platform/client";

export interface ErrorView {
  title: string;
  message: string;
  requestId?: string;
}

export function describeError(error: unknown): ErrorView {
  if (!(error instanceof PlatformError)) {
    return {
      title: "Something went wrong",
      message: "Reload the page, then retry.",
    };
  }
  switch (error.code) {
    case "NOT_CONNECTED":
      return {
        title: "Shop not connected",
        message:
          "This shop isn't connected to secure-cloud yet. Run LOCAL_DEV_MODE=true pnpm demo:setup, then reload.",
      };
    case "SECRETS_SEALED":
      return {
        title: "Temporarily unavailable",
        message:
          "The platform's secrets service is sealed, so payments, photos and receipts can't be used. Unseal it, then retry.",
        requestId: error.requestId,
      };
    case "PLATFORM_UNREACHABLE":
    case "UNREACHABLE":
    case "TIMEOUT":
      return {
        title: "Platform unreachable",
        message: error.message,
      };
    case "PROXY_POLICY_DENIED":
      return {
        title: "Blocked by the payment policy",
        message:
          "The platform's policy for this shop's payments refused this order (over S$500 a charge or S$2,000 a day). Nothing was charged, and the payment key was never used.",
        requestId: error.requestId,
      };
    case "PROXY_RATE_LIMITED":
      return {
        title: "Too many payments",
        message:
          "The platform's payment policy allows 20 payments a minute. Wait a moment, then retry.",
        requestId: error.requestId,
      };
    case "RATE_LIMITED":
      return {
        title: "Too many requests",
        message:
          "The shop is sending too many requests. Wait a moment, then retry.",
        requestId: error.requestId,
      };
    default:
      return {
        title: "Something went wrong",
        message: error.message,
        requestId: error.requestId,
      };
  }
}
