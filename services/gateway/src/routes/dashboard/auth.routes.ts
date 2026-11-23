import type { FastifyPluginCallback } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { strictValidatorCompiler } from "../../validation.js";
import { authController } from "../../controllers/dashboard/auth.controller.js";
import { oauthController } from "../../controllers/dashboard/oauth.controller.js";
import {
  changePasswordSchema,
  csrfSchema,
  loginSchema,
  logoutAllSchema,
  logoutSchema,
  meSchema,
  oauthCallbackSchema,
  oauthProvidersSchema,
  oauthStartSchema,
  signUpSchema,
} from "../../api/dashboard-schemas.js";
import type { DashboardOptions } from "./index.js";

export const authRoutes: FastifyPluginCallback<DashboardOptions> = (
  app,
  options,
  done,
) => {
  app.setValidatorCompiler(strictValidatorCompiler);
  app.removeContentTypeParser("text/plain");
  const auth = authController(options);
  const oauth = oauthController(options);
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  const publicRoute = { dashboardPublic: true };

  api.post(
    "/sign-up",
    { schema: signUpSchema, config: publicRoute },
    auth.signUp,
  );
  api.post("/login", { schema: loginSchema, config: publicRoute }, auth.login);
  api.get(
    "/oauth/providers",
    { schema: oauthProvidersSchema, config: publicRoute },
    oauth.providers,
  );
  api.get(
    "/oauth/:provider/start",
    { schema: oauthStartSchema, config: publicRoute },
    oauth.start,
  );
  api.get(
    "/oauth/:provider/callback",
    { schema: oauthCallbackSchema, config: publicRoute },
    oauth.callback,
  );
  api.post("/logout", { schema: logoutSchema }, auth.logout);
  api.post("/logout-all", { schema: logoutAllSchema }, auth.logoutAll);
  api.get("/me", { schema: meSchema }, auth.me);
  api.get("/csrf", { schema: csrfSchema }, auth.csrf);
  api.post(
    "/change-password",
    { schema: changePasswordSchema },
    auth.changePassword,
  );
  done();
};
