import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { Contract, loadSpec } from "../../api/validate.js";
import {
  createTenantWithKey,
  download,
  freshWindow,
  GATEWAY_URL,
  LIMITS,
  SECRET_MARKER,
  secrets,
  upload,
} from "./helpers.js";

const contract = new Contract(loadSpec("api/openapi.v1.json"));
const MISSING_ID = "00000000-0000-4000-8000-000000000000";

async function expectContract(
  method: string,
  path: string,
  response: Response,
) {
  const body = await response.text();
  expect(
    contract.checkResponse(method, path, {
      statusCode: response.status,
      headers: Object.fromEntries(response.headers),
      body,
    }),
  ).toEqual([]);
  return body;
}

beforeAll(freshWindow);

describe("the live gateway follows api/openapi.v1.json", () => {
  it("/health and /ready", async () => {
    await expectContract(
      "GET",
      "/health",
      await fetch(`${GATEWAY_URL}/health`),
    );
    await expectContract("GET", "/ready", await fetch(`${GATEWAY_URL}/ready`));
  });

  it("upload (201), download (200), missing file (404), malformed ID (400)", async () => {
    const { key } = await createTenantWithKey("e2e-contract");
    const auth = `Bearer ${key}`;

    const uploaded = await upload(key, randomBytes(1024));
    const { id } = JSON.parse(
      await expectContract("POST", "/v1/storage/files", uploaded),
    ) as {
      id: string;
    };
    expect(uploaded.status).toBe(201);

    const downloaded = await download(id, auth);
    expect(downloaded.status).toBe(200);
    await expectContract("GET", `/v1/storage/files/${id}`, downloaded);

    const missing = await download(MISSING_ID, auth);
    expect(missing.status).toBe(404);
    await expectContract("GET", `/v1/storage/files/${MISSING_ID}`, missing);

    const malformed = await download("not-a-valid-id", auth);
    expect(malformed.status).toBe(400);
    await expectContract("GET", "/v1/storage/files/not-a-valid-id", malformed);
  });

  it("another tenant's file is 404", async () => {
    const owner = await createTenantWithKey("e2e-contract-owner");
    const other = await createTenantWithKey("e2e-contract-other");
    const { id } = (await (
      await upload(owner.key, Buffer.from("private"))
    ).json()) as {
      id: string;
    };

    const response = await download(id, `Bearer ${other.key}`);

    expect(response.status).toBe(404);
    await expectContract("GET", `/v1/storage/files/${id}`, response);
  });

  it("401 without a key, 413 over the size limit", async () => {
    const { key } = await createTenantWithKey("e2e-contract-limits");

    const unauthorized = await download(MISSING_ID);
    expect(unauthorized.status).toBe(401);
    await expectContract(
      "GET",
      `/v1/storage/files/${MISSING_ID}`,
      unauthorized,
    );

    const tooLarge = await upload(key, randomBytes(LIMITS.maxUploadBytes + 1));
    expect(tooLarge.status).toBe(413);
    await expectContract("POST", "/v1/storage/files", tooLarge);
  });

  it("the old unversioned routes and /docs are gone (404)", async () => {
    const { key } = await createTenantWithKey("e2e-contract-old");

    const old = await fetch(`${GATEWAY_URL}/storage/files/${MISSING_ID}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    const docs = await fetch(`${GATEWAY_URL}/docs`);

    expect([old.status, docs.status]).toEqual([404, 404]);
  });

  it("every secrets route and its errors", async () => {
    const { key } = await createTenantWithKey("e2e-contract-secrets");
    const value = `${SECRET_MARKER}contract`;
    const calls: [
      "GET" | "PUT" | "POST" | "DELETE",
      string,
      string | undefined,
      number,
    ][] = [
      ["PUT", "/api-token", value, 201],
      ["PUT", "/api-token", value, 200],
      ["GET", "/api-token", undefined, 200],
      ["GET", "/api-token?version=1", undefined, 200],
      ["GET", "/api-token/versions?limit=1", undefined, 200],
      ["POST", "/api-token/rotate", value, 200],
      ["GET", "?limit=5", undefined, 200],
      ["GET", "/missing", undefined, 404],
      ["GET", "/-bad", undefined, 400],
      ["PUT", "/big", "x".repeat(LIMITS.maxSecretBytes + 1), 413],
      ["DELETE", "/api-token", undefined, 204],
    ];

    for (const [method, path, body, status] of calls) {
      const response = await secrets(key, method, path, body);
      expect(response.status).toBe(status);
      await expectContract(method, `/v1/secrets${path}`, response);
    }
    const unauthorized = await secrets("wrong", "GET", "");
    expect(unauthorized.status).toBe(401);
    await expectContract("GET", "/v1/secrets", unauthorized);
  });
});
