import { PlatformError } from "./platform/client";

export interface ErrorView {
  title: string;
  message: string;
  requestId?: string;
}

const PAYMENT_PROBLEMS: Record<string, ErrorView> = {
  cancelled: {
    title: "Payment cancelled",
    message: "You left Stripe's payment page. Nothing was charged.",
  },
  unpaid: {
    title: "Payment not completed",
    message:
      "Stripe hasn't confirmed this payment, so no order was made. Nothing was charged.",
  },
  unknown: {
    title: "Payment not found",
    message:
      "That payment doesn't belong to this account, or Stripe doesn't know it. No order was made.",
  },
  error: {
    title: "Couldn't check the payment",
    message:
      "The platform or Stripe didn't answer. If you paid, reload this page in a moment.",
  },
};

export function paymentProblem(value: string | string[] | undefined) {
  return typeof value === "string" ? PAYMENT_PROBLEMS[value] : undefined;
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
          "The platform's secrets service is sealed, so payments and photos can't be used. Unseal it, then retry.",
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
          "The platform's policy for this shop's Stripe payments refused this order (over S$500 a charge or S$2,000 a day). Nothing was charged, and the Stripe key was never used.",
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
