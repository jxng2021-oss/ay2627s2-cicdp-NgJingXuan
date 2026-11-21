import type { evaluateFlagsSchema } from "../api/flag-schemas.js";
import type { FlagsForwarder } from "../services/flags.service.js";
import type { Rep, Req } from "../types.js";

export function createFlagsController({ forward }: FlagsForwarder) {
  return {
    evaluate: (
      request: Req<typeof evaluateFlagsSchema>,
      reply: Rep<typeof evaluateFlagsSchema>,
    ) =>
      forward(request, reply, "POST", "/evaluate", {
        environment: request.body.environment,
        context: request.body.context,
        ...(request.body.keys ? { keys: request.body.keys } : {}),
      }),
  };
}
