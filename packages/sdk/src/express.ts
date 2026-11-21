import { SecureCloudError } from "./errors.js";

export interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string | undefined>;
  user?: unknown;
}

export interface ResponseLike {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
  json(body: unknown): unknown;
  headersSent?: boolean;
}

export type NextFunction = (error?: unknown) => void;
export type Middleware = (
  req: RequestLike,
  res: ResponseLike,
  next: NextFunction,
) => void | Promise<void>;
export type ErrorMiddleware = (
  error: unknown,
  req: RequestLike,
  res: ResponseLike,
  next: NextFunction,
) => void;

const PASS_THROUGH = new Set([400, 401, 403, 404, 409, 413, 429, 503]);

export function errorHandler(): ErrorMiddleware {
  return (error, _req, res, next) => {
    if (!(error instanceof SecureCloudError) || res.headersSent) {
      next(error);
      return;
    }
    if (error.code === "INVALID_API_KEY" || error.status === 0) {
      console.error(
        `[secure-cloud] ${error.code}: ${error.message}` +
          (error.requestId ? ` (request ${error.requestId})` : ""),
      );
      res.status(500);
      res.json({
        error: {
          code: "SERVER_ERROR",
          message: "Something went wrong on our side.",
        },
      });
      return;
    }
    const status = PASS_THROUGH.has(error.status) ? error.status : 502;
    res.status(status);
    res.json({ error: { code: error.code, message: error.message } });
  };
}

export function tokenFrom(
  req: RequestLike,
  cookie?: string,
): string | undefined {
  const header = req.headers.authorization;
  if (typeof header === "string") {
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (match) return match[1];
  }
  if (!cookie) return undefined;
  const parsed = req.cookies?.[cookie];
  if (parsed) return parsed;
  const raw = req.headers.cookie;
  if (typeof raw !== "string") return undefined;
  for (const part of raw.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === cookie) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
