import { asFunction, type AwilixContainer } from "awilix";
import { createAuthMiddleware, createKeycloakJwks, cookieToken } from "@molca/mes";
import type { AppConfig } from "./config/config.js";

function registerInfra(container: AwilixContainer, config: AppConfig) {
  container.register({
    authMw: asFunction(() =>
      createAuthMiddleware({
        issuer: config.oidc.baseUri,
        getKey: createKeycloakJwks(config.oidc.baseUri),
        getToken: cookieToken(config.cookie.name),
      }),
    ).singleton(),
  });
}

export { registerInfra };
