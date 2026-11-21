import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://127.0.0.1:8080";
const ORIGIN = process.env.DASHBOARD_ORIGIN ?? "http://localhost:3000";

export function fail(message: string): never {
  console.error(`✘ ${message}`);
  process.exit(1);
}

export function requireLocalDevMode(what: string): void {
  if (process.env.LOCAL_DEV_MODE !== "true") {
    fail(
      `${what} is for local development only: run it with LOCAL_DEV_MODE=true.`,
    );
  }
  const host = new URL(GATEWAY_URL).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    fail(`Refusing ${GATEWAY_URL}: only a gateway on this machine.`);
  }
}

export class Session {
  private readonly jar = new Map<string, string>();
  private csrf = "";

  async call(method: string, path: string, body?: unknown, raw?: Buffer) {
    const response = await fetch(`${GATEWAY_URL}/dashboard/v1${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.csrf && method !== "GET" ? { "x-csrf-token": this.csrf } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(raw
          ? { "content-type": "text/plain", "x-file-name": "demo.txt" }
          : {}),
      },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    this.keepCookies(response);
    const text = await response.text();
    if (response.status >= 400) {
      fail(`${method} ${path} answered ${response.status}: ${text}`);
    }
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
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

  async signUp(email: string, password: string, workspaceName: string) {
    const me = await this.call("POST", "/auth/sign-up", {
      email,
      password,
      workspaceName,
    });
    await this.refreshCsrf();
    return me as { user: { id: string }; workspaces: { id: string }[] };
  }

  async logIn(email: string, password: string) {
    const response = await fetch(`${GATEWAY_URL}/dashboard/v1/auth/login`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    this.keepCookies(response);
    if (response.status === 401) return undefined;
    if (!response.ok) {
      fail(
        `POST /auth/login answered ${response.status}: ${await response.text()}`,
      );
    }
    await this.refreshCsrf();
    return (await response.json()) as {
      user: { id: string };
      workspaces: { id: string; name: string }[];
    };
  }

  async refreshCsrf() {
    this.csrf = (await this.call("GET", "/auth/csrf")).csrfToken as string;
  }
}

export const LOCAL_OWNER_EMAIL = "demo-owner@example.test";
export const OWNER_FILE = ".local/owner.json";

export interface LocalAccount {
  session: Session;
  email: string;
  password: string;
  workspaces: { id: string; name: string; role: string }[];
}

export async function localAccount(
  email: string,
  savedPassword: string | undefined,
  workspaceName: string,
): Promise<LocalAccount> {
  const session = new Session();
  if (savedPassword) {
    const me = await session.logIn(email, savedPassword);
    if (me) {
      return {
        session,
        email,
        password: savedPassword,
        workspaces: me.workspaces as LocalAccount["workspaces"],
      };
    }
  }
  const password = `demo-${randomBytes(12).toString("base64url")}`;
  const signUp = await fetch(`${GATEWAY_URL}/dashboard/v1/auth/sign-up`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ email, password, workspaceName }),
  });
  if (signUp.status === 201) {
    const me = await session.logIn(email, password);
    if (!me) fail(`Couldn't sign in as ${email} after signing up.`);
    return {
      session,
      email,
      password,
      workspaces: me.workspaces as LocalAccount["workspaces"],
    };
  }
  if (signUp.status !== 409) {
    fail(
      `Signing up ${email} answered ${signUp.status}: ${await signUp.text()}`,
    );
  }
  const reset = spawnSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "gateway",
      "node",
      "dist/accounts-cli.js",
      "reset-password",
      email,
    ],
    { encoding: "utf8" },
  );
  const newPassword = reset.stdout.trim().split("\n").at(-1)?.trim();
  if (reset.status !== 0 || !newPassword) {
    fail(`Couldn't reset the password of ${email}: ${reset.stderr}`);
  }
  const me = await session.logIn(email, newPassword);
  if (!me) fail(`Couldn't sign in as ${email} after resetting its password.`);
  return {
    session,
    email,
    password: newPassword,
    workspaces: me.workspaces as LocalAccount["workspaces"],
  };
}

export async function ownedWorkspace(
  account: LocalAccount,
  name: string,
): Promise<string> {
  const found = account.workspaces.find(
    (w) => w.name === name && w.role === "owner",
  );
  if (found) return found.id;
  const created = await account.session.call("POST", "/workspaces", { name });
  if (typeof created.id !== "string")
    fail(`The workspace ${name} wasn't created.`);
  account.workspaces.push({ id: created.id, name, role: "owner" });
  return created.id;
}

export function savedOwnerPassword(): string | undefined {
  if (!existsSync(OWNER_FILE)) return undefined;
  const saved = JSON.parse(readFileSync(OWNER_FILE, "utf8")) as {
    email?: string;
    password?: string;
  };
  return saved.email === LOCAL_OWNER_EMAIL ? saved.password : undefined;
}

export function saveOwner(account: LocalAccount): void {
  mkdirSync(".local", { recursive: true });
  writeFileSync(
    OWNER_FILE,
    `${JSON.stringify({ email: account.email, password: account.password }, null, 2)}\n`,
    { mode: 0o600 },
  );
}
