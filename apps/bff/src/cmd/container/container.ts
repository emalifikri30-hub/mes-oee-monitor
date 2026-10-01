import { type AwilixContainer, createContainer as newContainer, InjectionMode } from "awilix";

import type { AppConfig } from "../../shared/config/config.js";
import type { AuthService } from "../../module/auth/auth-service.js";
import type { AuthMiddleware } from "@molca/mes";

import { registerInfra } from "../../shared/infra-module.js";
import { registerAuth } from "../../module/auth/auth-module.js";

type Cradle = {
  authService: AuthService;
  authMw: AuthMiddleware;
};

function createContainer(config: AppConfig): AwilixContainer<Cradle> {
  const container: AwilixContainer<Cradle> = newContainer<Cradle>({
    injectionMode: InjectionMode.PROXY,
    strict: true,
  });

  registerInfra(container, config);
  registerAuth(container, config);

  return container;
}

export { createContainer };
export type { Cradle };
