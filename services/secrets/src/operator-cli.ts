import { request } from "node:http";
import type { Readable, Writable } from "node:stream";

export interface OperatorIo {
  stdin: Readable & { isTTY?: boolean; setRawMode?: (raw: boolean) => void };
  stdout: Writable;
  stderr: Writable;
  socketPath: string;
}

interface Response {
  statusCode: number;
  body: Record<string, unknown>;
}

const USAGE = `Usage: node dist/operator.js <status|init|unseal|seal> [--json]

  status   show whether the service is initialised and sealed
  init     create the keys and show the 5 unseal key shares ONCE
  unseal   submit ONE share (from a hidden prompt, or one line on stdin);
           run it again for each share until 3 have been accepted
  seal     seal now: secrets are refused until unsealed again
`;

export async function runOperatorCommand(
  args: string[],
  io: OperatorIo,
): Promise<number> {
  const json = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  const [command, ...extra] = rest;
  const print = (text: string) => io.stdout.write(`${text}\n`);
  const error = (text: string) => io.stderr.write(`${text}\n`);

  if (extra.length > 0 || !command) {
    error(
      extra.length > 0
        ? "Unexpected arguments. Shares are never accepted on the command line: run `unseal` and enter the share when asked (or pipe it on stdin)."
        : USAGE,
    );
    return 2;
  }

  try {
    switch (command) {
      case "status": {
        const response = await call(io.socketPath, "GET", "/status");
        if (json) print(JSON.stringify(response.body));
        else print(describeStatus(response.body));
        return response.statusCode === 200 ? 0 : 1;
      }
      case "init": {
        const response = await call(io.socketPath, "POST", "/init");
        if (response.statusCode !== 201)
          return reportError(response, json, print, error);
        if (json) {
          print(JSON.stringify(response.body));
        } else {
          printShares(response.body, print);
        }
        return 0;
      }
      case "unseal": {
        const share = await readShare(io);
        if (!share) {
          error("No share entered.");
          return 2;
        }
        const response = await call(io.socketPath, "POST", "/unseal", {
          share,
        });
        if (response.statusCode !== 200)
          return reportError(response, json, print, error);
        if (json) {
          print(JSON.stringify(response.body));
        } else {
          const body = response.body;
          if (body.duplicate === true)
            print("That share was already submitted; it was ignored.");
          print(describeStatus(body));
        }
        return 0;
      }
      case "seal": {
        const response = await call(io.socketPath, "POST", "/seal");
        if (json) print(JSON.stringify(response.body));
        else
          print(
            "Sealed. Secrets are refused until 3 shares are entered again.",
          );
        return response.statusCode === 200 ? 0 : 1;
      }
      default:
        error(USAGE);
        return 2;
    }
  } catch (err) {
    error(
      `Could not reach the secrets service's operator socket (${io.socketPath}). Run this inside the secrets container while the service is running.${err instanceof Error ? ` (${err.message})` : ""}`,
    );
    return 1;
  }
}

function describeStatus(body: Record<string, unknown>): string {
  if (body.initialised === false) {
    return "Not initialised. Run `init` to create the keys.";
  }
  if (body.sealed === false) return "Unsealed: secrets are available.";
  return `Sealed. Unseal progress: ${String(body.progress)} of ${String(body.threshold)} shares.`;
}

function printShares(
  body: Record<string, unknown>,
  print: (text: string) => void,
) {
  const shares = Array.isArray(body.shares) ? (body.shares as string[]) : [];
  print(
    "Initialised. These are the unseal key shares. They are shown ONCE and stored nowhere.",
  );
  print(
    `Any ${String(body.threshold)} of them unseal the service. Give each to a different person and keep them safe.`,
  );
  print(
    "If more than 2 are lost, every stored secret is PERMANENTLY unrecoverable.\n",
  );
  shares.forEach((share, i) => print(`  Share ${i + 1}: ${share}`));
  print(
    "\nThe service is still sealed: run `unseal` 3 times, with 3 different shares.",
  );
}

function reportError(
  response: Response,
  json: boolean,
  print: (text: string) => void,
  error: (text: string) => void,
): number {
  if (json)
    print(
      JSON.stringify({ statusCode: response.statusCode, ...response.body }),
    );
  const details = response.body.error as
    { code?: string; message?: string } | undefined;
  error(`Failed: ${details?.message ?? `HTTP ${response.statusCode}`}`);
  return 1;
}

async function readShare(io: OperatorIo): Promise<string> {
  if (io.stdin.isTTY && io.stdin.setRawMode) {
    return hiddenPrompt(io);
  }
  return firstLine(io.stdin);
}

function hiddenPrompt(io: OperatorIo): Promise<string> {
  const { stdin } = io;
  io.stdout.write("Unseal key share (input hidden): ");
  return new Promise((resolve, reject) => {
    let typed = "";
    stdin.setRawMode?.(true);
    stdin.resume();
    const done = (result: string | Error) => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.off("data", onData);
      io.stdout.write("\n");
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") return done(typed);
        if (char === "\u0003") return done(new Error("cancelled"));
        if (char === "\u007f" || char === "\b") typed = typed.slice(0, -1);
        else typed += char;
      }
    };
    stdin.on("data", onData);
  });
}

function firstLine(stdin: Readable): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.off("end", finish);
      resolve(text.split(/\r?\n/)[0]?.trim() ?? "");
    };
    const onData = (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.includes("\n")) finish();
    };
    stdin.on("data", onData);
    stdin.on("end", finish);
    stdin.resume();
  });
}

function call(
  socketPath: string,
  method: "GET" | "POST",
  path: string,
  body?: object,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        socketPath,
        method,
        path,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            }
          : {},
        timeout: 30_000,
      },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
        res.on("end", () => {
          try {
            resolve({
              statusCode: res.statusCode ?? 0,
              body: JSON.parse(text) as Record<string, unknown>,
            });
          } catch {
            resolve({ statusCode: res.statusCode ?? 0, body: {} });
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end(payload);
  });
}
