import { Agent, request as sendRequest } from "undici";

export class SealedError extends Error {
  constructor() {
    super("the secrets service is sealed");
    this.name = "SealedError";
  }
}

export interface KeyVault {
  wrap(
    tenantId: string,
    poolId: string,
    dataKey: Buffer,
    requestId: string,
  ): Promise<Buffer>;
  unwrap(
    tenantId: string,
    poolId: string,
    wrapped: Buffer,
    requestId: string,
  ): Promise<Buffer>;
}

export class SecretsKeyVault implements KeyVault {
  private readonly agent: Agent;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    timeoutMs: number,
  ) {
    this.agent = new Agent({
      connectTimeout: timeoutMs,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
  }

  close(): Promise<void> {
    return this.agent.close();
  }

  async wrap(
    tenantId: string,
    poolId: string,
    dataKey: Buffer,
    requestId: string,
  ): Promise<Buffer> {
    const { wrappedKey } = await this.call<{ wrappedKey: string }>(
      "wrap",
      tenantId,
      requestId,
      { poolId, key: dataKey.toString("base64") },
    );
    return Buffer.from(wrappedKey, "base64");
  }

  async unwrap(
    tenantId: string,
    poolId: string,
    wrapped: Buffer,
    requestId: string,
  ): Promise<Buffer> {
    const { key } = await this.call<{ key: string }>(
      "unwrap",
      tenantId,
      requestId,
      { poolId, wrappedKey: wrapped.toString("base64") },
    );
    return Buffer.from(key, "base64");
  }

  private async call<T>(
    action: "wrap" | "unwrap",
    tenantId: string,
    requestId: string,
    body: object,
  ): Promise<T> {
    const response = await sendRequest(
      `${this.baseUrl.replace(/\/$/, "")}/internal/signing-keys/${action}`,
      {
        dispatcher: this.agent,
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          "x-tenant-id": tenantId,
          "x-request-id": requestId,
        },
        body: JSON.stringify(body),
      },
    );
    const answer = (await response.body.json().catch(() => undefined)) as
      (T & { error?: { code?: string } }) | undefined;
    if (
      response.statusCode === 503 &&
      answer?.error?.code === "SECRETS_SEALED"
    ) {
      throw new SealedError();
    }
    if (response.statusCode !== 200 || !answer) {
      throw new Error(
        `the secrets service answered ${response.statusCode} to ${action}`,
      );
    }
    return answer;
  }
}
