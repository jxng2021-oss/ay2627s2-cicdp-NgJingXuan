import { createPublicKey, verify, type JsonWebKey } from "node:crypto";
import { SecureCloudError } from "./errors.js";
import { tokenFrom, type Middleware } from "./express.js";
import { Http, segment } from "./http.js";

export interface PoolUser {
  id: string;
  email: string;
  status: "active" | "disabled";
  locked: boolean;
  passwordResetRequired: boolean;
  attributes: Record<string, string | number | boolean>;
  roles: string[];
  createdAt: string;
  lastLoginAt: string | null;
}

export interface Role {
  name: string;
  description: string;
  permissions: string[];
  userCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  refreshToken: string;
  passwordResetRequired: boolean;
  user: PoolUser;
}

export interface SignedInUser {
  id: string;
  email: string;
  attributes: Record<string, string | number | boolean>;
  roles: string[];
  permissions: string[];
  expiresAt: Date;
}

const KEY_CACHE_MS = 5 * 60_000;

export class UserPool {
  private keys?: { keys: JsonWebKey[]; until: number };

  constructor(
    private readonly http: Http,
    readonly poolId: string,
  ) {
    if (!/^[0-9a-f-]{36}$/.test(poolId)) {
      throw new SecureCloudError(
        0,
        "INVALID_POOL_ID",
        "That isn't a user pool ID. Copy it from the dashboard: User pools, then your pool.",
      );
    }
  }

  private path(rest: string): string {
    return `/v1/user-pools/${segment(this.poolId)}${rest}`;
  }

  signUp(input: {
    email: string;
    password: string;
    attributes?: Record<string, string | number | boolean>;
  }): Promise<PoolUser> {
    return this.http.json<PoolUser>(this.path("/users"), Http.body(input));
  }

  signIn(input: { email: string; password: string }): Promise<Session> {
    return this.http.json<Session>(this.path("/sessions"), Http.body(input));
  }

  refresh(refreshToken: string): Promise<Session> {
    return this.http.json<Session>(
      this.path("/sessions/refresh"),
      Http.body({ refreshToken }),
    );
  }

  async signOut(refreshToken: string): Promise<void> {
    await this.http.call(
      this.path("/sessions/revoke"),
      Http.body({ refreshToken }),
    );
  }

  getUser(userId: string): Promise<PoolUser> {
    return this.http.json<PoolUser>(this.path(`/users/${segment(userId)}`));
  }

  async changePassword(
    userId: string,
    input: { currentPassword: string; newPassword: string },
  ): Promise<void> {
    await this.http.call(
      this.path(`/users/${segment(userId)}/password`),
      Http.body(input),
    );
  }

  async verify(accessToken: string): Promise<SignedInUser> {
    const invalid = (why: string) =>
      new SecureCloudError(
        401,
        "INVALID_TOKEN",
        `This token can't be used: ${why}.`,
      );
    const [header, payload, signature] = accessToken.split(".");
    if (!header || !payload || !signature) throw invalid("it isn't a token");
    let head: { kid?: unknown; alg?: unknown };
    let claims: Record<string, unknown>;
    try {
      head = JSON.parse(
        Buffer.from(header, "base64url").toString(),
      ) as typeof head;
      claims = JSON.parse(
        Buffer.from(payload, "base64url").toString(),
      ) as typeof claims;
    } catch {
      throw invalid("it isn't a token");
    }
    if (head.alg !== "ES256") throw invalid("it isn't signed with ES256");
    let jwk = (await this.publicKeys()).find((key) => key.kid === head.kid);
    jwk ??= (await this.publicKeys(true)).find((key) => key.kid === head.kid);
    if (!jwk) throw invalid("it wasn't signed by this pool");
    const genuine = verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      {
        key: createPublicKey({ key: jwk, format: "jwk" }),
        dsaEncoding: "ieee-p1363",
      },
      Buffer.from(signature, "base64url"),
    );
    if (!genuine) throw invalid("its signature is wrong");
    if (claims.aud !== this.poolId) throw invalid("it is for another pool");
    if (claims.token_use !== "access")
      throw invalid("it isn't an access token");
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) {
      throw invalid("it has expired");
    }
    if (typeof claims.sub !== "string" || typeof claims.email !== "string") {
      throw invalid("it has no user");
    }
    const attributes =
      typeof claims.attributes === "object" && claims.attributes !== null
        ? (claims.attributes as SignedInUser["attributes"])
        : {};
    const strings = (value: unknown) =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
    return {
      id: claims.sub,
      email: claims.email,
      attributes,
      roles: strings(claims.roles),
      permissions: strings(claims.permissions),
      expiresAt: new Date(claims.exp * 1000),
    };
  }

  requireUser(options: { cookie?: string } = {}): Middleware {
    return this.guard(options, () => true);
  }

  requireRole(role: string, options: { cookie?: string } = {}): Middleware {
    return this.guard(options, (user) => user.roles.includes(role));
  }

  requirePermission(
    permission: string,
    options: { cookie?: string } = {},
  ): Middleware {
    return this.guard(options, (user) => hasPermission(user, permission));
  }

  private guard(
    options: { cookie?: string },
    allowed: (user: SignedInUser) => boolean,
  ): Middleware {
    return async (req, res, next) => {
      const token = tokenFrom(req, options.cookie);
      let user: SignedInUser;
      try {
        if (!token)
          throw new SecureCloudError(401, "UNAUTHORIZED", "Sign in first.");
        user = await this.verify(token);
      } catch (error) {
        if (error instanceof SecureCloudError && error.status === 401) {
          res.status(401);
          res.json({
            error: { code: "UNAUTHORIZED", message: "Sign in first." },
          });
          return;
        }
        next(error);
        return;
      }
      req.user = user;
      if (!allowed(user)) {
        res.status(403);
        res.json({
          error: {
            code: "FORBIDDEN",
            message: "You don't have permission to do this.",
          },
        });
        return;
      }
      next();
    };
  }

  async listRoles(): Promise<Role[]> {
    return (await this.http.json<{ roles: Role[] }>(this.path("/roles"))).roles;
  }

  createRole(input: {
    name: string;
    description?: string;
    permissions: string[];
  }): Promise<Role> {
    return this.http.json<Role>(this.path("/roles"), Http.body(input));
  }

  getRole(name: string): Promise<Role> {
    return this.http.json<Role>(this.path(`/roles/${segment(name)}`));
  }

  updateRole(
    name: string,
    changes: { description?: string; permissions?: string[] },
  ): Promise<Role> {
    return this.http.json<Role>(this.path(`/roles/${segment(name)}`), {
      ...Http.body(changes),
      method: "PATCH",
    });
  }

  async deleteRole(name: string): Promise<void> {
    await this.http.call(this.path(`/roles/${segment(name)}`), {
      method: "DELETE",
    });
  }

  addRole(userId: string, role: string): Promise<PoolUser> {
    return this.http.json<PoolUser>(
      this.path(`/users/${segment(userId)}/roles/${segment(role)}`),
      { method: "PUT" },
    );
  }

  removeRole(userId: string, role: string): Promise<PoolUser> {
    return this.http.json<PoolUser>(
      this.path(`/users/${segment(userId)}/roles/${segment(role)}`),
      { method: "DELETE" },
    );
  }

  private async publicKeys(force = false): Promise<JsonWebKey[]> {
    if (!force && this.keys && this.keys.until > Date.now())
      return this.keys.keys;
    const { keys } = await this.http.json<{ keys: JsonWebKey[] }>(
      this.path("/jwks.json"),
      { withKey: false },
    );
    this.keys = { keys, until: Date.now() + KEY_CACHE_MS };
    return keys;
  }
}

export function hasPermission(
  user: Pick<SignedInUser, "permissions">,
  permission: string,
): boolean {
  return user.permissions.some((granted) => {
    if (granted === "*" || granted === permission) return true;
    if (granted.endsWith(":*") || granted.endsWith(".*")) {
      return permission.startsWith(granted.slice(0, -1));
    }
    return false;
  });
}
