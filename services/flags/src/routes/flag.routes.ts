import type { FastifyInstance } from "fastify";
import type { createFlagController } from "../controllers/flag.controller.js";
import {
  EnvironmentParams,
  EnvironmentSettings,
  EvaluateBody,
  FlagChangesBody,
  FlagParams,
  NewFlagBody,
} from "../schemas.js";

export function flagRoutes(
  app: FastifyInstance,
  controller: ReturnType<typeof createFlagController>,
): void {
  app.get("/flags", controller.list);
  app.post("/flags", { schema: { body: NewFlagBody } }, controller.create);
  app.get("/flags/:key", { schema: { params: FlagParams } }, controller.get);
  app.patch(
    "/flags/:key",
    { schema: { params: FlagParams, body: FlagChangesBody } },
    controller.update,
  );
  app.put(
    "/flags/:key/environments/:environment",
    { schema: { params: EnvironmentParams, body: EnvironmentSettings } },
    controller.setEnvironment,
  );
  app.delete(
    "/flags/:key",
    { schema: { params: FlagParams } },
    controller.remove,
  );
  app.post(
    "/evaluate",
    { schema: { body: EvaluateBody } },
    controller.evaluate,
  );
  app.delete("/tenant", controller.removeTenant);
}
