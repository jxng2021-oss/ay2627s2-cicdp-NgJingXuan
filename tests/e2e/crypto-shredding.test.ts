import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  FILE_CONTENT_MARKER,
  freshWindow,
  GATEWAY_URL,
  upload,
} from "./helpers.js";
import { dockerCompose } from "./operator.js";

const ORIGIN = process.env.DASHBOARD_ORIGIN ?? "http://localhost:3000";
const PASSWORD = `e2e-shred-${randomBytes(8).toString("hex")}`;

class Browser {
  private readonly jar = new Map<string, string>();
  csrf = "";

  async call(method: string, path: string, body?: unknown) {
    const response = await fetch(`${GATEWAY_URL}/dashboard/v1${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.csrf && method !== "GET" ? { "x-csrf-token": this.csrf } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.keepCookies(response);
    return response;
  }

  private keepCookies(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";")[0] ?? "";
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      if (value) this.jar.set(name, value);
      else this.jar.delete(name);
    }
  }

  get cookie(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async signUp(workspaceName: string): Promise<string> {
    const response = await this.call("POST", "/auth/sign-up", {
      email: `e2e-shred-${randomBytes(4).toString("hex")}@example.test`,
      password: PASSWORD,
      workspaceName,
    });
    expect(response.status).toBe(201);
    this.csrf = (
      (await (await this.call("GET", "/auth/csrf")).json()) as {
        csrfToken: string;
      }
    ).csrfToken;
    return ((await response.json()) as { workspaces: { id: string }[] })
      .workspaces[0]!.id;
  }
}

async function inDocker(...args: string[]): Promise<string> {
  const result = await dockerCompose(args);
  if (result.code !== 0) throw new Error(`docker compose: ${result.stderr}`);
  return result.stdout.trim();
}

function unwrapStatus(tenantId: string, fileId: string, wrappedKey: string) {
  const body = JSON.stringify({ fileId, wrappedKey });
  return inDocker(
    "exec",
    "-T",
    "storage",
    "sh",
    "-c",
    `wget -q -S -O /dev/null \
      --header "x-tenant-id: ${tenantId}" \
      --header "x-request-id: $(cat /proc/sys/kernel/random/uuid)" \
      --header "content-type: application/json" \
      --header "authorization: Bearer $INTERNAL_SERVICE_TOKEN" \
      --post-data '${body}' \
      http://secrets:3002/internal/file-keys/unwrap 2>&1 \
      | awk '/HTTP/ { print $2; exit }'`,
  );
}

const single = (sql: string, user: string, db: string) =>
  inDocker(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    user,
    "-d",
    db,
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    sql,
  );

beforeAll(freshWindow);

describe("crypto-shredding a workspace", () => {
  it("leaves a copy of a file and its wrapped key that can never be decrypted", async () => {
    const browser = new Browser();
    const name = `Shred me ${randomBytes(3).toString("hex")}`;
    const workspace = await browser.signUp(name);
    const created = await browser.call(
      "POST",
      `/workspaces/${workspace}/api-keys`,
      { name: "e2e" },
    );
    const { key } = (await created.json()) as { key: string };
    await browser.call("PUT", `/workspaces/${workspace}/secrets/db`, {
      value: "e2e-shred-secret",
    });

    const content = Buffer.from(
      `${FILE_CONTENT_MARKER}shred ${"x".repeat(5000)}`,
    );
    const uploaded = await upload(key, content, {
      "content-type": "text/plain",
    });
    expect(uploaded.status).toBe(201);
    const { id: fileId } = (await uploaded.json()) as { id: string };

    const [wrappedKey, blobId] = (
      await single(
        `select encode(encrypted_file_key, 'base64') || '|' || blob_id from files where id = '${fileId}'`,
        "storage_app",
        "storage",
      )
    )
      .replace(/\s+/g, "")
      .split("|");
    const copy = Buffer.from(
      await inDocker(
        "exec",
        "-T",
        "storage",
        "base64",
        "-w",
        "0",
        `/data/${workspace}/${blobId}`,
      ),
      "base64",
    );
    expect(copy.length).toBeGreaterThan(content.length);
    expect(copy.includes(Buffer.from(FILE_CONTENT_MARKER))).toBe(false);
    expect(await unwrapStatus(workspace, fileId, wrappedKey!)).toBe("200");

    const wrong = await browser.call("DELETE", `/workspaces/${workspace}`, {
      confirmName: "not the name",
    });
    expect(wrong.status).toBe(400);
    const deleted = await browser.call("DELETE", `/workspaces/${workspace}`, {
      confirmName: name,
    });
    expect(deleted.status).toBe(204);

    expect(await unwrapStatus(workspace, fileId, wrappedKey!)).toBe("404");
    expect(
      await single(
        `select count(*) from tenant_keys where tenant_id = '${workspace}'`,
        "secrets_app",
        "secrets",
      ),
    ).toBe("0");
    expect(
      await single(
        `select count(*) from shredded_tenants where tenant_id = '${workspace}'`,
        "secrets_app",
        "secrets",
      ),
    ).toBe("1");
    expect(
      await single(
        `select count(*) from files where tenant_id = '${workspace}'`,
        "storage_app",
        "storage",
      ),
    ).toBe("0");
    expect(
      await single(
        `select status from tenants where id = '${workspace}'`,
        "gateway_app",
        "platform",
      ),
    ).toBe("deleted");

    const withKey = await fetch(`${GATEWAY_URL}/v1/storage/files`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(withKey.status).toBe(401);
    const gone = await browser.call("GET", `/workspaces/${workspace}`);
    expect(gone.status).toBe(404);
  });

  it("records the deletion on the platform chain", async () => {
    const rows = await single(
      "select count(*) from audit_events where action = 'tenant.shredded' and chain = 'platform'",
      "audit_app",
      "audit",
    );
    expect(Number(rows)).toBeGreaterThan(0);
  });
});
