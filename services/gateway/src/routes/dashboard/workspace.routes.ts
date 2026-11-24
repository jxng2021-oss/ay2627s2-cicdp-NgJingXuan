import type { FastifyPluginCallback } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { sendError } from "../../errors.js";
import { secretsForwarder } from "../../services/secrets.service.js";
import { storageForwarder } from "../../services/storage.service.js";
import { streamBodies } from "../storage.routes.js";
import { Upstream } from "../../services/upstream.service.js";
import { flagsForwarder } from "../../services/flags.service.js";
import { userPoolsForwarder } from "../../services/user-pools.service.js";
import { strictValidatorCompiler } from "../../validation.js";
import { analyticsController } from "../../controllers/dashboard/analytics.controller.js";
import { apiKeysController } from "../../controllers/dashboard/api-keys.controller.js";
import { auditController } from "../../controllers/dashboard/audit.controller.js";
import { connectionsController } from "../../controllers/dashboard/connections.controller.js";
import { dashboardWebhooksController } from "../../controllers/dashboard/webhooks.controller.js";
import { filesController } from "../../controllers/dashboard/files.controller.js";
import { secretsController } from "../../controllers/dashboard/secrets.controller.js";
import { workspaceDeletionController } from "../../controllers/dashboard/workspace-deletion.controller.js";
import { workspaceController } from "../../controllers/dashboard/workspace.controller.js";
import { dashboardFlagsController } from "../../controllers/dashboard/flags.controller.js";
import { membershipController } from "../../controllers/dashboard/membership.controller.js";
import { dashboardPoolsController } from "../../controllers/dashboard/user-pools.controller.js";
import { membershipService } from "../../services/membership.service.js";
import * as schemas from "../../api/dashboard-schemas.js";
import type { DashboardOptions } from "./index.js";

export const workspaceRoutes: FastifyPluginCallback<DashboardOptions> = (
  app,
  options,
  done,
) => {
  const upstream = {
    connectTimeoutMs: options.connectTimeoutMs,
    responseTimeoutMs: options.responseTimeoutMs,
  };
  const secrets = secretsForwarder({
    ...upstream,
    secretsUrl: options.secretsUrl,
    maxSecretBytes: options.maxSecretBytes,
  });
  const storage = storageForwarder({
    ...upstream,
    storageUrl: options.storageUrl,
    maxUploadBytes: options.maxUploadBytes,
  });
  const userPools = userPoolsForwarder({
    ...upstream,
    identityUrl: options.identityUrl,
  });
  const flagService = flagsForwarder({
    ...upstream,
    flagsUrl: options.flagsUrl,
  });
  const auditService = new Upstream({
    label: "Audit service",
    baseUrl: options.auditUrl,
    ...upstream,
  });
  app.addHook("onClose", async () => {
    await Promise.all([
      secrets.close(),
      storage.close(),
      auditService.close(),
      userPools.close(),
      flagService.close(),
    ]);
  });

  const memberships = membershipService(options.db, options.audit);
  app.addHook("preHandler", async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const membership = await memberships.find(
      request.dashboardUserId!,
      workspaceId,
    );
    if (!membership) {
      return sendError(reply, 404, "NOT_FOUND", "Workspace not found");
    }
    if (membership.status === "deleted") {
      return sendError(reply, 404, "NOT_FOUND", "Workspace not found");
    }
    if (
      membership.status === "deleting" &&
      !request.routeOptions.config.whileDeleting
    ) {
      return sendError(
        reply,
        409,
        "CONFLICT",
        "This workspace is being deleted",
      );
    }
    if (membership.status === "suspended") {
      return sendError(reply, 403, "FORBIDDEN", "This workspace is suspended");
    }
    if (request.routeOptions.config.ownerOnly && membership.role !== "owner") {
      return sendError(
        reply,
        403,
        "FORBIDDEN",
        "Only workspace owners can do this",
      );
    }
    request.tenantId = membership.tenantId;
    request.dashboardWorkspace = membership;
  });

  const owner = { ownerOnly: true };
  const overview = workspaceController({
    secrets: secrets.upstream,
    storage: storage.upstream,
  });

  app.register((json, _opts, jsonDone) => {
    json.setValidatorCompiler(strictValidatorCompiler);
    json.removeContentTypeParser("text/plain");
    const api = json.withTypeProvider<TypeBoxTypeProvider>();
    const keys = apiKeysController(options);
    const secret = secretsController(secrets);
    const connections = connectionsController(options);
    const webhooks = dashboardWebhooksController(options);
    const audit = auditController(
      auditService,
      options.auditToken,
      userPools.upstream,
    );
    const bodyLimit = options.maxSecretBytes * 6 + 1024;

    api.get("", { schema: schemas.overviewSchema }, (request) =>
      overview.overview(request, request.dashboardWorkspace!),
    );
    api.delete(
      "/membership",
      { schema: schemas.leaveWorkspaceSchema },
      membershipController(options).leave,
    );
    api.delete(
      "",
      {
        schema: schemas.deleteWorkspaceSchema,
        config: { ownerOnly: true, whileDeleting: true },
      },
      workspaceDeletionController(options, {
        secrets: secrets.upstream,
        storage: storage.upstream,
        identity: userPools.upstream,
        flags: flagService.upstream,
      }),
    );

    api.get("/api-keys", { schema: schemas.listKeysSchema }, keys.list);
    api.post(
      "/api-keys",
      { schema: schemas.createKeySchema, config: owner },
      keys.create,
    );
    api.delete(
      "/api-keys/:keyId",
      { schema: schemas.revokeKeySchema, config: owner },
      keys.revoke,
    );
    api.delete(
      "/revoked-api-keys/:keyId",
      { schema: schemas.removeRevokedKeySchema, config: owner },
      keys.remove,
    );

    api.get(
      "/secrets",
      { schema: schemas.listSecretsDashboardSchema },
      secret.list,
    );
    api.put(
      "/secrets/:name",
      { schema: schemas.putSecretDashboardSchema, config: owner, bodyLimit },
      secret.put,
    );
    api.post(
      "/secrets/:name/rotate",
      { schema: schemas.rotateSecretDashboardSchema, config: owner, bodyLimit },
      secret.rotate,
    );
    api.delete(
      "/secrets/:name",
      { schema: schemas.deleteSecretDashboardSchema, config: owner },
      secret.remove,
    );
    api.get(
      "/secrets/:name/versions",
      { schema: schemas.listVersionsDashboardSchema },
      secret.versions,
    );

    api.get(
      "/proxy-connections",
      { schema: schemas.listConnectionsDashboardSchema },
      connections.list,
    );
    api.put(
      "/proxy-connections/:name",
      { schema: schemas.putConnectionDashboardSchema, config: owner },
      connections.put,
    );
    api.get(
      "/proxy-connections/:name/usage",
      { schema: schemas.connectionUsageDashboardSchema },
      connections.usage,
    );
    api.delete(
      "/proxy-connections/:name",
      { schema: schemas.deleteConnectionDashboardSchema, config: owner },
      connections.remove,
    );

    api.get(
      "/webhooks",
      { schema: schemas.listWebhookEndpointsSchema },
      webhooks.list,
    );
    api.post(
      "/webhooks",
      { schema: schemas.createWebhookEndpointSchema, config: owner },
      webhooks.create,
    );
    api.patch(
      "/webhooks/:endpointId",
      { schema: schemas.updateWebhookEndpointSchema, config: owner },
      webhooks.update,
    );
    api.delete(
      "/webhooks/:endpointId",
      { schema: schemas.deleteWebhookEndpointSchema, config: owner },
      webhooks.remove,
    );
    api.get(
      "/webhooks/:endpointId/events",
      { schema: schemas.listWebhookEndpointEventsSchema },
      webhooks.events,
    );
    api.post(
      "/webhooks/:endpointId/events/:eventId/redeliver",
      { schema: schemas.redeliverWebhookEventSchema, config: owner },
      webhooks.redeliver,
    );

    api.get(
      "/audit-events",
      { schema: schemas.listAuditDashboardSchema },
      audit.list,
    );
    const poolsController = dashboardPoolsController(userPools.forward);
    api.get(
      "/user-pools",
      { schema: schemas.listPoolsSchema },
      poolsController.listPools,
    );
    api.post(
      "/user-pools",
      { schema: schemas.createPoolSchema, config: owner },
      poolsController.createPool,
    );
    api.get(
      "/user-pools/:poolId",
      { schema: schemas.getPoolSchema },
      poolsController.getPool,
    );
    api.patch(
      "/user-pools/:poolId",
      { schema: schemas.updatePoolSchema, config: owner },
      poolsController.updatePool,
    );
    api.delete(
      "/user-pools/:poolId",
      { schema: schemas.deletePoolSchema, config: owner },
      poolsController.deletePool,
    );
    api.get(
      "/user-pools/:poolId/roles",
      { schema: schemas.listPoolRolesSchema },
      poolsController.listPoolRoles,
    );
    api.post(
      "/user-pools/:poolId/roles",
      { schema: schemas.createPoolRoleSchema, config: owner },
      poolsController.createPoolRole,
    );
    api.patch(
      "/user-pools/:poolId/roles/:role",
      { schema: schemas.updatePoolRoleSchema, config: owner },
      poolsController.updatePoolRole,
    );
    api.delete(
      "/user-pools/:poolId/roles/:role",
      { schema: schemas.deletePoolRoleSchema, config: owner },
      poolsController.deletePoolRole,
    );
    api.put(
      "/user-pools/:poolId/users/:userId/roles/:role",
      { schema: schemas.addPoolUserRoleSchema, config: owner },
      poolsController.addPoolUserRole,
    );
    api.delete(
      "/user-pools/:poolId/users/:userId/roles/:role",
      { schema: schemas.removePoolUserRoleSchema, config: owner },
      poolsController.removePoolUserRole,
    );
    api.get(
      "/user-pools/:poolId/users",
      { schema: schemas.listPoolUsersSchema },
      poolsController.listPoolUsers,
    );
    api.get(
      "/user-pools/:poolId/users/:userId",
      { schema: schemas.getPoolUserDashboardSchema },
      poolsController.getPoolUserDashboard,
    );
    api.patch(
      "/user-pools/:poolId/users/:userId",
      { schema: schemas.updatePoolUserSchema, config: owner },
      poolsController.updatePoolUser,
    );
    api.delete(
      "/user-pools/:poolId/users/:userId",
      { schema: schemas.deletePoolUserSchema, config: owner },
      poolsController.deletePoolUser,
    );
    api.post(
      "/user-pools/:poolId/users/:userId/reset-password",
      { schema: schemas.resetPoolUserPasswordSchema, config: owner },
      poolsController.resetPoolUserPassword,
    );
    api.post(
      "/user-pools/:poolId/users/:userId/unlock",
      { schema: schemas.unlockPoolUserSchema, config: owner },
      poolsController.unlockPoolUser,
    );
    api.get(
      "/user-pools/:poolId/audit-events",
      { schema: schemas.listPoolAuditEventsSchema },
      audit.listPool,
    );

    const flagsController = dashboardFlagsController(flagService.forward);
    api.get(
      "/flags",
      { schema: schemas.listFlagsSchema },
      flagsController.listFlags,
    );
    api.post(
      "/flags",
      { schema: schemas.createFlagSchema, config: owner },
      flagsController.createFlag,
    );
    api.get(
      "/flags/:key",
      { schema: schemas.getFlagSchema },
      flagsController.getFlag,
    );
    api.patch(
      "/flags/:key",
      { schema: schemas.updateFlagSchema, config: owner },
      flagsController.updateFlag,
    );
    api.put(
      "/flags/:key/environments/:environment",
      { schema: schemas.setFlagEnvironmentSchema, config: owner },
      flagsController.setFlagEnvironment,
    );
    api.delete(
      "/flags/:key",
      { schema: schemas.deleteFlagSchema, config: owner },
      flagsController.deleteFlag,
    );
    api.post(
      "/flags/evaluate",
      { schema: schemas.testFlagsSchema },
      flagsController.testFlags,
    );

    api.get(
      "/analytics",
      { schema: schemas.analyticsSchema },
      analyticsController(auditService, options.auditToken),
    );
    jsonDone();
  });

  app.register((raw, _opts, rawDone) => {
    streamBodies(raw);
    const api = raw.withTypeProvider<TypeBoxTypeProvider>();
    const files = filesController(storage);
    api.get("/files", { schema: schemas.listFilesDashboardSchema }, files.list);
    api.post(
      "/files",
      { schema: schemas.uploadFileDashboardSchema },
      files.upload,
    );
    api.get(
      "/files/:id",
      { schema: schemas.downloadFileDashboardSchema },
      files.download,
    );
    api.get(
      "/files/:id/metadata",
      { schema: schemas.fileMetadataDashboardSchema },
      files.metadata,
    );
    api.delete(
      "/files/:id",
      { schema: schemas.deleteFileDashboardSchema, config: owner },
      files.remove,
    );
    api.get("/usage", { schema: schemas.usageDashboardSchema }, files.usage);
    rawDone();
  });
  done();
};
