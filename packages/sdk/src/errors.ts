export class SecureCloudError extends Error {
  override readonly name = "SecureCloudError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

export function isSecureCloudError(error: unknown): error is SecureCloudError {
  return error instanceof SecureCloudError;
}

const API_KEY_REFUSED = "A valid API key is required";

export async function platformError(
  response: Response,
): Promise<SecureCloudError | undefined> {
  const headerId = response.headers.get("x-request-id") ?? undefined;
  try {
    const body = (await response.clone().json()) as {
      error?: { code?: unknown; message?: unknown; requestId?: unknown };
    };
    const error = body.error;
    if (typeof error?.code === "string" && typeof error.message === "string") {
      const badKey =
        response.status === 401 && error.message === API_KEY_REFUSED;
      return new SecureCloudError(
        response.status,
        badKey ? "INVALID_API_KEY" : error.code,
        error.message,
        typeof error.requestId === "string" ? error.requestId : headerId,
      );
    }
  } catch {}
  return undefined;
}

export async function errorFrom(response: Response): Promise<SecureCloudError> {
  return (
    (await platformError(response)) ??
    new SecureCloudError(
      response.status,
      "UNEXPECTED_RESPONSE",
      `secure-cloud answered ${response.status}.`,
      response.headers.get("x-request-id") ?? undefined,
    )
  );
}
