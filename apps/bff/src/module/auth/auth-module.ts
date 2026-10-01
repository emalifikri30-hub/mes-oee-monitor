import { asFunction, type AwilixContainer } from "awilix";
import type { AppConfig } from "../../shared/config/config.js";
import { createAuthService } from "./auth-service.js";

function registerAuth(container: AwilixContainer, config: AppConfig) {
  container.register({
    authService: asFunction(() => createAuthService(config)).singleton(),
  });
}

export { registerAuth };
