import type { FastifyReply, FastifyRequest } from "fastify";
import { Upstream } from "./upstream.service.js";

export interface UserPoolsOptions {
  identityUrl: string;
  connectTimeoutMs: number;
  responseTimeoutMs: number;
}

export function userPoolsForwarder(options: UserPoolsOptions) {
  const identity = new Upstream({
    label: "Identity service",
    baseUrl: options.identityUrl,
    connectTimeoutMs: options.connectTimeoutMs,
    responseTimeoutMs: options.responseTimeoutMs,
  });

  function forward(
    request: FastifyRequest,
    reply: FastifyReply,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: object,
    query: Record<string, string | number | undefined> = {},
  ) {
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) search.set(name, String(value));
    }
    const queryString = search.size > 0 ? `?${search.toString()}` : "";
    return identity.forward(request, reply, {
      method,
      path: path + queryString,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  return { forward, upstream: identity, close: () => identity.close() };
}

export type UserPoolsForwarder = ReturnType<typeof userPoolsForwarder>;

export const poolPath = (poolId: string, rest = "") =>
  `/pools/${encodeURIComponent(poolId)}${rest}`;
export const userPath = (poolId: string, userId: string, rest = "") =>
  poolPath(poolId, `/users/${encodeURIComponent(userId)}${rest}`);
export const rolePath = (poolId: string, role = "") =>
  poolPath(poolId, `/roles${role ? `/${encodeURIComponent(role)}` : ""}`);
export const userRolePath = (poolId: string, userId: string, role: string) =>
  userPath(poolId, userId, `/roles/${encodeURIComponent(role)}`);

export const roleBody = (body: {
  name?: string;
  description?: string;
  permissions?: string[];
}) => ({
  ...(body.name !== undefined ? { name: body.name } : {}),
  ...(body.description !== undefined ? { description: body.description } : {}),
  ...(body.permissions !== undefined ? { permissions: body.permissions } : {}),
});
