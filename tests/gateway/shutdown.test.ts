import type { AddressInfo } from "node:net";
import { request } from "undici";
import { describe, expect, it } from "vitest";
import {
  createTenantWithKey,
  createTestDatabase,
  startFakeStorage,
  startGateway,
} from "./helpers.js";

describe("graceful shutdown", () => {
  it("finishes requests in progress, refuses new ones, then closes", async () => {
    const { db } = await createTestDatabase();
    let reachedStorage!: () => void;
    const reached = new Promise<void>((resolve) => (reachedStorage = resolve));
    const storageUrl = await startFakeStorage((_req, res) => {
      reachedStorage();
      setTimeout(() => res.end("finished"), 500);
    });
    const app = await startGateway({ db, storageUrl });
    const { key } = await createTenantWithKey(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const auth = { authorization: `Bearer ${key}` };

    const inProgress = request(
      `${url}/v1/storage/files/00000000-0000-4000-8000-000000000000`,
      { headers: auth },
    );
    await reached;

    const closing = app.close();
    const late = await request(`${url}/health`).then(
      async (r) => ({ status: r.statusCode, body: await r.body.text() }),
      () => ({ status: "refused" as const, body: "" }),
    );

    const finished = await inProgress;
    expect(finished.statusCode).toBe(200);
    expect(await finished.body.text()).toBe("finished");
    expect([503, "refused"]).toContain(late.status);
    if (late.status === 503) expect(late.body).toContain("SERVICE_UNAVAILABLE");

    await closing;
    await expect(request(`${url}/health`)).rejects.toThrow();
  });
});
