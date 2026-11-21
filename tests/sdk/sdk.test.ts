import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  SecureCloud,
  SecureCloudError,
  errorHandler,
  hasPermission,
} from "../../packages/sdk/src/index.js";
import {
  API_KEY,
  FILE_ID,
  POOL_ID,
  fakeGateway,
  json,
  platformError,
} from "./helpers.js";

describe("setting up", () => {
  it("needs an API key, and says where to get one", () => {
    const before = process.env.SECURE_CLOUD_API_KEY;
    delete process.env.SECURE_CLOUD_API_KEY;
    try {
      expect(() => new SecureCloud()).toThrow(/SECURE_CLOUD_API_KEY/);
    } finally {
      if (before !== undefined) process.env.SECURE_CLOUD_API_KEY = before;
    }
  });

  it("reads the key and URL from the environment", async () => {
    const gateway = await fakeGateway((_req, res) =>
      json(res, 200, { files: [], nextCursor: null }),
    );
    process.env.SECURE_CLOUD_API_KEY = API_KEY;
    process.env.SECURE_CLOUD_URL = `${gateway.url}/`;
    try {
      await new SecureCloud().files.list();
    } finally {
      delete process.env.SECURE_CLOUD_API_KEY;
      delete process.env.SECURE_CLOUD_URL;
    }
    expect(gateway.seen[0]!.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("uses the global fetch as it is at each call", async () => {
    const cloud = new SecureCloud({
      apiKey: API_KEY,
      url: "http://gateway.test",
    });
    const fake = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ files: [], nextCursor: null }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fake);
    try {
      await cloud.files.list();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fake).toHaveBeenCalledOnce();
  });

  it("refuses a URL that isn't one, and never shows the key", () => {
    expect(
      () => new SecureCloud({ apiKey: API_KEY, url: "localhost:8080" }),
    ).toThrow(/isn't the gateway's address/);
    const cloud = new SecureCloud({ apiKey: API_KEY });
    expect(JSON.stringify(cloud)).not.toContain(API_KEY);
  });

  it("a refused API key gets its own code", async () => {
    const gateway = await fakeGateway((_req, res) =>
      platformError(res, 401, "UNAUTHORIZED", "A valid API key is required"),
    );
    const cloud = new SecureCloud({ apiKey: API_KEY, url: gateway.url });
    await expect(cloud.files.list()).rejects.toMatchObject({
      status: 401,
      code: "INVALID_API_KEY",
    });
  });

  it("an unreachable gateway is a clear error without the key in it", async () => {
    const cloud = new SecureCloud({
      apiKey: API_KEY,
      url: "http://127.0.0.1:1",
    });
    const error = await cloud.files.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecureCloudError);
    expect(error).toMatchObject({ status: 0, code: "UNREACHABLE" });
    expect(String((error as Error).message)).not.toContain(API_KEY);
  });
});

describe("connections", () => {
  it("calls the route with a JSON body, and the platform adds the key", async () => {
    const gateway = await fakeGateway((_req, res) =>
      json(res, 201, { id: "ch_7f3a91", status: "succeeded" }),
    );
    const cloud = new SecureCloud({ apiKey: API_KEY, url: gateway.url });

    const charge = await cloud.connections.call(
      "payments",
      "POST /charges",
      { amount: 1849 },
      {
        headers: { Authorization: "Bearer stolen", "Idempotency-Key": "k1" },
        query: { expand: true },
      },
    );

    expect(charge).toMatchObject({
      status: 201,
      ok: true,
      data: { id: "ch_7f3a91" },
    });
    const [request] = gateway.seen;
    expect(request).toMatchObject({
      method: "POST",
      path: "/v1/proxy/payments/charges?expand=true",
    });
    expect(JSON.parse(request!.body.toString())).toEqual({ amount: 1849 });
    expect(request!.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(request!.headers["idempotency-key"]).toBe("k1");
  });

  it("returns the outside API's errors, and throws the platform's refusals", async () => {
    let answer: "outside" | "policy" = "outside";
    const gateway = await fakeGateway((_req, res) =>
      answer === "outside"
        ? json(res, 402, { message: "card declined" })
        : platformError(
            res,
            403,
            "PROXY_POLICY_DENIED",
            "Refused by the connection's policy",
          ),
    );
    const cloud = new SecureCloud({ apiKey: API_KEY, url: gateway.url });

    const declined = await cloud.connections.call(
      "payments",
      "POST /charges",
      {},
    );
    expect(declined).toMatchObject({
      status: 402,
      ok: false,
      data: { message: "card declined" },
    });

    answer = "policy";
    await expect(
      cloud.connections.call("payments", "POST /charges", {}),
    ).rejects.toMatchObject({
      status: 403,
      code: "PROXY_POLICY_DENIED",
      requestId: "7c41e9d2-0000-4000-8000-000000000000",
    });
  });

  it("a GET by default; routes that could leave the connection are refused", async () => {
    const gateway = await fakeGateway((_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end("pong");
    });
    const cloud = new SecureCloud({ apiKey: API_KEY, url: gateway.url });
    expect((await cloud.connections.call("status", "/ping")).data).toBe("pong");
    expect(gateway.seen[0]!.method).toBe("GET");

    for (const route of [
      "charges",
      "POST /../admin",
      "//evil.example/x",
      "FLY /x",
    ]) {
      await expect(
        cloud.connections.call("payments", route),
      ).rejects.toMatchObject({
        code: "INVALID_ROUTE",
      });
    }
    expect(gateway.seen).toHaveLength(1);
  });
});

describe("files", () => {
  const info = {
    id: FILE_ID,
    size: 5,
    name: "hello world.txt",
    contentType: "text/plain",
    createdAt: "2026-11-16T09:30:00.000Z",
  };

  it("uploads a Buffer, a path, a multer file and a stream, with a name and type", async () => {
    const gateway = await fakeGateway((_req, res) => json(res, 201, info));
    const cloud = new SecureCloud({ apiKey: API_KEY, url: gateway.url });
    const dir = mkdtempSync(join(tmpdir(), "sdk-"));
    writeFileSync(join(dir, "photo.png"), "png!");

    await cloud.files.upload(Buffer.from("hello"), { name: "hello world.txt" });
    await cloud.files.upload(join(dir, "photo.png"));
    await cloud.files.upload({
      originalname: "a.pdf",
      mimetype: "application/pdf",
      buffer: Buffer.from("%PDF"),
    });
    await cloud.files.upload(Readable.from([Buffer.from("streamed")]), {
      name: "s.bin",
    });

    const [buffer, path, multer, stream] = gateway.seen;
    expect(buffer).toMatchObject({ method: "POST", path: "/v1/storage/files" });
    expect(buffer!.headers["x-file-name"]).toBe("hello%20world.txt");
    expect(buffer!.headers["content-type"]).toBe("text/plain");
    expect(buffer!.body.toString()).toBe("hello");
    expect(path!.headers["x-file-name"]).toBe("photo.png");
    expect(path!.headers["content-type"]).toBe("image/png");
    expect(path!.body.toString()).toBe("png!");
    expect(multer!.headers["content-type"]).toBe("application/pdf");
    expect(stream!.headers["content-type"]).toBe("application/octet-stream");
    expect(stream!.body.toString()).toBe("streamed");
  });

  it("a missing path is a clear error, before any upload", async () => {
    const gateway = await fakeGateway((_req, res) => json(res, 201, info));
    const cloud = new SecureCloud({ apiKey: API_KEY, url: gateway.url });
    await expect(
      cloud.files.upload("./no-such-file.txt"),
    ).rejects.toMatchObject({
      code: "FILE_NOT_FOUND",
    });
    expect(gateway.seen).toHaveLength(0);
  });

  it("lists every page, gets details, downloads and deletes", async () => {
    const gateway = await fakeGateway((req, res) => {
      if (req.path.startsWith("/v1/storage/files?")) {
        const second = req.path.includes("cursor=next");
        return json(res, 200, {
          files: [{ ...info, id: second ? "b" : "a" }],
          nextCursor: second ? null : "next",
        });
      }
      if (req.path.endsWith("/metadata")) return json(res, 200, info);
      if (req.method === "DELETE") {
        res.statusCode = 204;
        return res.end();
      }
      res.setHeader("content-type", "application/octet-stream");
      res.end("hello");
    });
    const cloud = new SecureCloud({ apiKey: API_KEY, url: gateway.url });

    expect((await cloud.files.list()).map((f) => f.id)).toEqual(["a", "b"]);
    expect(await cloud.files.get(FILE_ID)).toEqual(info);
    const target = join(mkdtempSync(join(tmpdir(), "sdk-")), "copy.txt");
    await cloud.files.download(FILE_ID, target);
    expect(readFileSync(target, "utf8")).toBe("hello");
    await cloud.files.delete(FILE_ID);
    expect(gateway.seen.at(-1)).toMatchObject({
      method: "DELETE",
      path: `/v1/storage/files/${FILE_ID}`,
    });
  });

  it("send() streams a file to a response as a download, never inline", async () => {
    const gateway = await fakeGateway((req, res) => {
      if (req.path.endsWith("/metadata"))
        return json(res, 200, { ...info, name: 'naïve "x".html' });
      res.end("hello");
    });
    const cloud = new SecureCloud({ apiKey: API_KEY, url: gateway.url });
    const app = createServer(
      (_req, res) => void cloud.files.send(res, FILE_ID),
    );
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = app.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/`);
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-disposition")).toBe(
        `attachment; filename="na_ve x.html"; filename*=UTF-8''na%C3%AFve%20x.html`,
      );
      expect(await response.text()).toBe("hello");
    } finally {
      app.close();
    }
  });

  it("platform errors keep their code, status and request ID", async () => {
    const gateway = await fakeGateway((_req, res) =>
      platformError(res, 404, "NOT_FOUND", "File not found"),
    );
    const cloud = new SecureCloud({ apiKey: API_KEY, url: gateway.url });
    await expect(cloud.files.get(FILE_ID)).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
      message: "File not found",
    });
  });
});

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});
const JWK = {
  ...publicKey.export({ format: "jwk" }),
  kid: "key-1",
  alg: "ES256",
  use: "sig",
};

function token(claims: Record<string, unknown>, kid = "key-1"): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "ES256", typ: "JWT", kid }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: "user-1",
      email: "ada@example.com",
      aud: POOL_ID,
      token_use: "access",
      exp: Math.floor(Date.now() / 1000) + 300,
      attributes: { plan: "pro" },
      roles: ["support"],
      permissions: ["orders:*", "posts:read"],
      ...claims,
    }),
  ).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

async function poolGateway() {
  return fakeGateway((req, res) => {
    if (req.path.endsWith("/jwks.json")) return json(res, 200, { keys: [JWK] });
    if (req.path.endsWith("/sessions")) {
      return json(res, 200, {
        accessToken: token({}),
        tokenType: "Bearer",
        expiresIn: 300,
        refreshToken: "r1",
        user: { id: "user-1" },
      });
    }
    json(res, 201, { id: "user-1", email: "ada@example.com" });
  });
}

describe("user pools", () => {
  it("refuses an ID that isn't a pool ID", () => {
    const cloud = new SecureCloud({ apiKey: API_KEY });
    expect(() => cloud.userPool("my-pool")).toThrow(/isn't a user pool ID/);
  });

  it("signs up and in through the pool's routes", async () => {
    const gateway = await poolGateway();
    const users = new SecureCloud({
      apiKey: API_KEY,
      url: gateway.url,
    }).userPool(POOL_ID);
    await users.signUp({
      email: "ada@example.com",
      password: "a long password",
    });
    const session = await users.signIn({
      email: "ada@example.com",
      password: "a long password",
    });
    expect(session.refreshToken).toBe("r1");
    expect(gateway.seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST /v1/user-pools/${POOL_ID}/users`,
      `POST /v1/user-pools/${POOL_ID}/sessions`,
    ]);
  });

  it("verifies access tokens locally, with the public keys fetched without the API key", async () => {
    const gateway = await poolGateway();
    const users = new SecureCloud({
      apiKey: API_KEY,
      url: gateway.url,
    }).userPool(POOL_ID);

    const user = await users.verify(token({}));
    expect(user).toMatchObject({
      id: "user-1",
      email: "ada@example.com",
      attributes: { plan: "pro" },
    });
    await users.verify(token({}));
    const keyFetches = gateway.seen.filter((r) =>
      r.path.endsWith("/jwks.json"),
    );
    expect(keyFetches).toHaveLength(1);
    expect(keyFetches[0]!.headers.authorization).toBeUndefined();
  });

  it("refuses expired, foreign, refresh and forged tokens", async () => {
    const gateway = await poolGateway();
    const users = new SecureCloud({
      apiKey: API_KEY,
      url: gateway.url,
    }).userPool(POOL_ID);
    const forged = token({}).replace(/\.[^.]+$/, ".AAAA");
    for (const bad of [
      token({ exp: Math.floor(Date.now() / 1000) - 1 }),
      token({ aud: "8b9e3c1a-0000-4a6b-9c8d-1e2f3a4b5c6d" }),
      token({ token_use: "refresh" }),
      token({}, "unknown-key"),
      forged,
      "not-a-token",
    ]) {
      await expect(users.verify(bad)).rejects.toMatchObject({
        status: 401,
        code: "INVALID_TOKEN",
      });
    }
  });

  it("requireUser() lets signed in users through and answers 401 to the rest", async () => {
    const gateway = await poolGateway();
    const users = new SecureCloud({
      apiKey: API_KEY,
      url: gateway.url,
    }).userPool(POOL_ID);
    const guard = users.requireUser({ cookie: "access_token" });
    const run = async (headers: Record<string, string>) => {
      const req: { headers: Record<string, string>; user?: unknown } = {
        headers,
      };
      const res = {
        code: 0,
        body: undefined as unknown,
        status(c: number) {
          this.code = c;
        },
        json(b: unknown) {
          this.body = b;
        },
        setHeader() {},
      };
      const next = vi.fn();
      await guard(req, res, next);
      return { req, res, next };
    };

    const bearer = await run({ authorization: `Bearer ${token({})}` });
    expect(bearer.next).toHaveBeenCalledWith();
    expect(bearer.req.user).toMatchObject({ email: "ada@example.com" });

    const cookie = await run({
      cookie: `theme=dark; access_token=${token({})}`,
    });
    expect(cookie.req.user).toMatchObject({ id: "user-1" });

    const refusedHeaders: Record<string, string>[] = [
      {},
      { authorization: "Bearer nope" },
    ];
    for (const headers of refusedHeaders) {
      const refused = await run(headers);
      expect(refused.next).not.toHaveBeenCalled();
      expect(refused.res.code).toBe(401);
      expect(refused.res.body).toEqual({
        error: { code: "UNAUTHORIZED", message: "Sign in first." },
      });
    }
  });
});

describe("errorHandler()", () => {
  const response = () => ({
    code: 0,
    body: undefined as unknown,
    status(c: number) {
      this.code = c;
    },
    json(b: unknown) {
      this.body = b;
    },
    setHeader() {},
  });

  it("answers a user's mistake with its status and message", () => {
    const res = response();
    errorHandler()(
      new SecureCloudError(404, "NOT_FOUND", "File not found"),
      { headers: {} },
      res,
      vi.fn(),
    );
    expect(res).toMatchObject({
      code: 404,
      body: { error: { code: "NOT_FOUND", message: "File not found" } },
    });
  });

  it("hides setup problems (a wrong API key) behind a plain 500, logged on the server", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = response();
    errorHandler()(
      new SecureCloudError(
        401,
        "INVALID_API_KEY",
        "A valid API key is required",
      ),
      { headers: {} },
      res,
      vi.fn(),
    );
    expect(res.code).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/API key/);
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it("a user's wrong password stays a 401", () => {
    const res = response();
    errorHandler()(
      new SecureCloudError(401, "UNAUTHORIZED", "Wrong email or password"),
      { headers: {} },
      res,
      vi.fn(),
    );
    expect(res.code).toBe(401);
  });

  it("passes other errors on to Express", () => {
    const next = vi.fn();
    const error = new Error("boom");
    errorHandler()(error, { headers: {} }, response(), next);
    expect(next).toHaveBeenCalledWith(error);
  });
});

describe("roles", () => {
  it("manages roles and gives them to users through the pool's routes", async () => {
    const gateway = await fakeGateway((req, res) => {
      if (req.path.includes("/users/"))
        return json(res, 200, { id: "user-1", roles: ["support"] });
      if (req.method === "DELETE" && req.path.endsWith("/roles/support")) {
        res.statusCode = 204;
        return res.end();
      }
      if (req.path.endsWith("/roles") && req.method === "GET")
        return json(res, 200, { roles: [{ name: "support" }] });
      json(res, req.method === "POST" ? 201 : 200, {
        name: "support",
        permissions: ["orders:read"],
      });
    });
    const users = new SecureCloud({
      apiKey: API_KEY,
      url: gateway.url,
    }).userPool(POOL_ID);

    await users.createRole({ name: "support", permissions: ["orders:read"] });
    expect((await users.listRoles()).map((r) => r.name)).toEqual(["support"]);
    await users.getRole("support");
    await users.updateRole("support", { permissions: ["orders:*"] });
    expect((await users.addRole("user-1", "support")).roles).toEqual([
      "support",
    ]);
    await users.removeRole("user-1", "support");
    await users.deleteRole("support");

    const base = `/v1/user-pools/${POOL_ID}`;
    expect(gateway.seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST ${base}/roles`,
      `GET ${base}/roles`,
      `GET ${base}/roles/support`,
      `PATCH ${base}/roles/support`,
      `PUT ${base}/users/user-1/roles/support`,
      `DELETE ${base}/users/user-1/roles/support`,
      `DELETE ${base}/roles/support`,
    ]);
    expect(JSON.parse(gateway.seen[3]!.body.toString())).toEqual({
      permissions: ["orders:*"],
    });
    expect(
      gateway.seen.every(
        (r) => r.headers.authorization === `Bearer ${API_KEY}`,
      ),
    ).toBe(true);
  });

  it("verify() gives the token's roles and permissions", async () => {
    const gateway = await poolGateway();
    const users = new SecureCloud({
      apiKey: API_KEY,
      url: gateway.url,
    }).userPool(POOL_ID);
    expect(await users.verify(token({}))).toMatchObject({
      roles: ["support"],
      permissions: ["orders:*", "posts:read"],
    });
    expect(
      await users.verify(token({ roles: undefined, permissions: undefined })),
    ).toMatchObject({
      roles: [],
      permissions: [],
    });
  });

  it("hasPermission() understands exact names and wildcards", () => {
    const user = { permissions: ["orders:*", "posts.read", "billing.*"] };
    expect(hasPermission(user, "orders:refund")).toBe(true);
    expect(hasPermission(user, "posts.read")).toBe(true);
    expect(hasPermission(user, "billing.invoices")).toBe(true);
    expect(hasPermission(user, "posts.write")).toBe(false);
    expect(hasPermission(user, "ordersx:refund")).toBe(false);
    expect(hasPermission({ permissions: ["*"] }, "anything:at.all")).toBe(true);
    expect(hasPermission({ permissions: [] }, "orders:read")).toBe(false);
  });

  it("requireRole() and requirePermission() answer 401 signed out and 403 without the right", async () => {
    const gateway = await poolGateway();
    const users = new SecureCloud({
      apiKey: API_KEY,
      url: gateway.url,
    }).userPool(POOL_ID);
    const run = async (
      guard: ReturnType<typeof users.requireRole>,
      headers: Record<string, string>,
    ) => {
      const req: { headers: Record<string, string>; user?: unknown } = {
        headers,
      };
      const res = {
        code: 0,
        body: undefined as unknown,
        status(c: number) {
          this.code = c;
        },
        json(b: unknown) {
          this.body = b;
        },
        setHeader() {},
      };
      const next = vi.fn();
      await guard(req, res, next);
      return { req, res, next };
    };
    const bearer = { authorization: `Bearer ${token({})}` };

    expect(
      (await run(users.requireRole("support"), bearer)).next,
    ).toHaveBeenCalledWith();
    expect(
      (await run(users.requirePermission("orders:refund"), bearer)).next,
    ).toHaveBeenCalledWith();

    const noRole = await run(users.requireRole("admin"), bearer);
    expect(noRole.next).not.toHaveBeenCalled();
    expect(noRole.res.code).toBe(403);
    expect(noRole.res.body).toMatchObject({ error: { code: "FORBIDDEN" } });

    const noPermission = await run(
      users.requirePermission("posts:write"),
      bearer,
    );
    expect(noPermission.res.code).toBe(403);

    const signedOut = await run(users.requirePermission("orders:refund"), {});
    expect(signedOut.res.code).toBe(401);
  });
});
