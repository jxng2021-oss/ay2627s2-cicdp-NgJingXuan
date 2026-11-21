import type * as schemas from "../../api/dashboard-schemas.js";
import { flagPath, type FlagsForwarder } from "../../services/flags.service.js";
import type { Rep, Req } from "../../types.js";

export function dashboardFlagsController(flagsApi: FlagsForwarder["forward"]) {
  return {
    listFlags: (
      request: Req<typeof schemas.listFlagsSchema>,
      reply: Rep<typeof schemas.listFlagsSchema>,
    ) => flagsApi(request, reply, "GET", "/flags"),

    createFlag: (
      request: Req<typeof schemas.createFlagSchema>,
      reply: Rep<typeof schemas.createFlagSchema>,
    ) => flagsApi(request, reply, "POST", "/flags", request.body),

    getFlag: (
      request: Req<typeof schemas.getFlagSchema>,
      reply: Rep<typeof schemas.getFlagSchema>,
    ) => flagsApi(request, reply, "GET", flagPath(request.params.key)),

    updateFlag: (
      request: Req<typeof schemas.updateFlagSchema>,
      reply: Rep<typeof schemas.updateFlagSchema>,
    ) =>
      flagsApi(request, reply, "PATCH", flagPath(request.params.key), {
        description: request.body.description,
      }),

    setFlagEnvironment: (
      request: Req<typeof schemas.setFlagEnvironmentSchema>,
      reply: Rep<typeof schemas.setFlagEnvironmentSchema>,
    ) =>
      flagsApi(
        request,
        reply,
        "PUT",
        flagPath(
          request.params.key,
          `/environments/${request.params.environment}`,
        ),
        request.body,
      ),

    deleteFlag: (
      request: Req<typeof schemas.deleteFlagSchema>,
      reply: Rep<typeof schemas.deleteFlagSchema>,
    ) => flagsApi(request, reply, "DELETE", flagPath(request.params.key)),

    testFlags: (
      request: Req<typeof schemas.testFlagsSchema>,
      reply: Rep<typeof schemas.testFlagsSchema>,
    ) => flagsApi(request, reply, "POST", "/evaluate", request.body),
  };
}
