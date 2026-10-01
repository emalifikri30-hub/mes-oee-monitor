import { asFunction, type AwilixContainer } from "awilix";

import type { AppConfig } from "../../shared/config/config.js";

import { KeycloakProbe, PostgresProbe } from "./health-service.js";

function registerHealth(container: AwilixContainer, config: AppConfig) {
  container.register({
    keycloakProbe: asFunction(
      () => new KeycloakProbe({ oidcBase: config.oidc.baseUri }),
    ).singleton(),
    goldProbe: asFunction(
      ({ goldDb }) => new PostgresProbe({ db: goldDb, label: "gold" }),
    ).singleton(),
    silverProbe: asFunction(
      ({ silverDb }) => new PostgresProbe({ db: silverDb, label: "silver" }),
    ).singleton(),
  });
}

export { registerHealth };
