import { PlatformError } from "./platform/client";

export interface ErrorView {
  title: string;
  message: string;
  requestId?: string;
}

const PAYMENT_PROBLEMS: Record<string, ErrorView> = {
  cancelled: {
    title: "Payment cancelled",
    message: "You left the payment page. Nothing was charged.",
  },
  unpaid: {
    title: "Payment not completed",
    message: "The payment wasn't confirmed, so no order was made.",
  },
  unknown: {
    title: "Payment not found",
    message: "We couldn't find this payment, so no order was made.",
  },
  error: {
    title: "Couldn't check the payment",
    message: "If you paid, reload this page in a moment.",
  },
};

const SOMETHING_WENT_WRONG = {
  title: "Something went wrong",
  message: "Try again in a moment.",
};

export function paymentProblem(value: string | string[] | undefined) {
  return typeof value === "string" ? PAYMENT_PROBLEMS[value] : undefined;
}

function logForDeveloper(error: unknown): void {
  if (error instanceof PlatformError) {
    console.error("secure-cloud request failed", {
      status: error.status,
      code: error.code,
      requestId: error.requestId,
      message: error.message,
    });
  } else {
    console.error("unexpected error", error);
  }
}

export function describeError(error: unknown): ErrorView {
  logForDeveloper(error);
  if (!(error instanceof PlatformError)) return SOMETHING_WENT_WRONG;
  const requestId = error.requestId;
  switch (error.code) {
    case "PROXY_POLICY_DENIED":
      return {
        title: "Blocked by the payment policy",
        message:
          "This order is over the shop's payment limit. Try a smaller order.",
        requestId,
      };
    case "PROXY_RATE_LIMITED":
      return {
        title: "Too many payments",
        message: "Wait a minute, then try again.",
        requestId,
      };
    case "RATE_LIMITED":
      return {
        title: "Too many requests",
        message: "Wait a moment, then try again.",
        requestId,
      };
    default:
      return { ...SOMETHING_WENT_WRONG, requestId };
  }
}
