import type { FastifyBaseLogger } from "fastify";
import type { AuditClient, AuditEvent } from "../audit.js";
import type { Database } from "../db/client.js";
import {
  ENVIRONMENTS,
  type Environment,
  type EnvironmentSettings,
  type Flag,
  type FlagValue,
} from "../db/schema.js";
import { AppError } from "../errors.js";
import { evaluate } from "../evaluate.js";
import {
  deleteFlag,
  deleteTenantFlags,
  findFlag,
  insertFlag,
  listFlags,
  updateFlag,
  type Queryable,
} from "../models/flag.model.js";

export interface Actor {
  tenantId: string;
  actorId: string | undefined;
  actorType: "api_key" | "user";
  clientIp: string | undefined;
  requestId: string;
  log: FastifyBaseLogger;
}

export interface NewFlag {
  key: string;
  kind: Flag["kind"];
  offValue: FlagValue;
  description?: string;
}

export type FlagService = ReturnType<typeof createFlagService>;

export function createFlagService(db: Database, audit: AuditClient) {
  const event = (actor: Actor, action: string, flagId: string): AuditEvent => ({
    action,
    outcome: "success",
    actorType: actor.actorId ? actor.actorType : "service",
    tenantId: actor.tenantId,
    ...(actor.actorId ? { actorId: actor.actorId } : {}),
    resourceId: flagId,
    requestId: actor.requestId,
    ...(actor.clientIp ? { sourceIp: actor.clientIp } : {}),
  });

  const recorded = (
    actor: Actor,
    action: string,
    change: (tx: Queryable) => Promise<Flag | undefined>,
  ): Promise<Flag | undefined> =>
    db.transaction(async (tx) => {
      const flag = await change(tx);
      if (flag) await audit.record(event(actor, action, flag.id), actor.log);
      return flag;
    });

  const found = (flag: Flag | undefined): Flag => {
    if (!flag) throw new AppError(404, "NOT_FOUND", "Flag not found");
    return flag;
  };

  return {
    list: (actor: Actor) => listFlags(db, actor.tenantId),

    get: async (actor: Actor, key: string) =>
      found(await findFlag(db, actor.tenantId, key)),

    async create(actor: Actor, input: NewFlag): Promise<Flag> {
      const { key, kind, offValue, description = "" } = input;
      checkKind(kind, [offValue]);
      const start: EnvironmentSettings = {
        enabled: false,
        rules: [],
        defaultValue: offValue,
      };
      const flag = await recorded(actor, "feature_flag.created", (tx) =>
        insertFlag(tx, {
          tenantId: actor.tenantId,
          key,
          description,
          kind,
          offValue,
          environments: Object.fromEntries(
            ENVIRONMENTS.map((environment) => [environment, start]),
          ) as Record<Environment, EnvironmentSettings>,
        }),
      );
      if (!flag)
        throw new AppError(
          409,
          "CONFLICT",
          "A flag with this key already exists",
        );
      return flag;
    },

    update: async (
      actor: Actor,
      key: string,
      description: string | undefined,
    ) =>
      found(
        await recorded(actor, "feature_flag.updated", (tx) =>
          updateFlag(tx, actor.tenantId, key, { description }),
        ),
      ),

    async setEnvironment(
      actor: Actor,
      key: string,
      environment: Environment,
      settings: EnvironmentSettings,
    ): Promise<Flag> {
      const current = found(await findFlag(db, actor.tenantId, key));
      checkKind(current.kind, [
        settings.defaultValue,
        ...settings.rules.map((rule) => rule.value),
        ...(settings.rollout ? [settings.rollout.value] : []),
      ]);
      const before = current.environments[environment];
      const onlyToggled =
        canonical({ ...before, enabled: settings.enabled }) ===
        canonical(settings);
      return found(
        await recorded(
          actor,
          onlyToggled ? "feature_flag.toggled" : "feature_flag.updated",
          (tx) =>
            updateFlag(tx, actor.tenantId, key, {
              environments: {
                ...current.environments,
                [environment]: settings,
              },
            }),
        ),
      );
    },

    async remove(actor: Actor, key: string): Promise<void> {
      const deleted = await db.transaction(async (tx) => {
        const id = await deleteFlag(tx, actor.tenantId, key);
        if (id)
          await audit.record(
            event(actor, "feature_flag.deleted", id),
            actor.log,
          );
        return id;
      });
      if (!deleted) throw new AppError(404, "NOT_FOUND", "Flag not found");
    },

    async evaluate(
      actor: Actor,
      environment: Environment,
      context: Parameters<typeof evaluate>[2],
      keys: string[] | undefined,
    ) {
      const results: Record<string, ReturnType<typeof evaluate>> = {};
      for (const flag of await listFlags(db, actor.tenantId, keys)) {
        results[flag.key] = evaluate(flag, environment, context);
      }
      return results;
    },

    removeTenant: (actor: Actor) => deleteTenantFlags(db, actor.tenantId),
  };
}

function checkKind(kind: Flag["kind"], values: FlagValue[]): void {
  const wrong = values.some((value) =>
    kind === "boolean" ? typeof value !== "boolean" : typeof value !== "string",
  );
  if (wrong)
    throw new AppError(
      400,
      "BAD_REQUEST",
      kind === "boolean"
        ? "Every value of a boolean flag must be true or false"
        : "Every value of a string flag must be text",
    );
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : inner,
  );
}
