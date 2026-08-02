import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function activate(api) {
  const serverModule = join(
    api.appRoot,
    "node_modules",
    "@github",
    "copilot-language-server",
    "dist",
    "language-server.js",
  );
  const copilotHome = join(api.storageDir, "home");
  const copilotCacheHome = join(api.storageDir, "cache");
  const xdgConfigHome = join(api.storageDir, "xdg", "config");
  const xdgDataHome = join(api.storageDir, "xdg", "data");
  const xdgStateHome = join(api.storageDir, "xdg", "state");
  const xdgCacheHome = join(api.storageDir, "xdg", "cache");
  for (const directory of [copilotHome, copilotCacheHome, xdgConfigHome, xdgDataHome, xdgStateHome, xdgCacheHome]) {
    mkdirSync(directory, { recursive: true });
  }

  api.registerHostEnvironmentTransformer((environment, context) => {
    if (context.hostMode !== "desktop") return environment;
    return {
      ...environment,
      NOEMA_COPILOT_PLUGIN: api.manifest.id,
      AARONNOTE_COPILOT_HOME: environment.COPILOT_HOME || copilotHome,
      AARONNOTE_COPILOT_CACHE_HOME: environment.COPILOT_CACHE_HOME || copilotCacheHome,
      AARONNOTE_COPILOT_XDG_CONFIG_HOME: environment.XDG_CONFIG_HOME || xdgConfigHome,
      AARONNOTE_COPILOT_XDG_DATA_HOME: environment.XDG_DATA_HOME || xdgDataHome,
      AARONNOTE_COPILOT_XDG_STATE_HOME: environment.XDG_STATE_HOME || xdgStateHome,
      AARONNOTE_COPILOT_XDG_CACHE_HOME: environment.XDG_CACHE_HOME || xdgCacheHome,
      ...(!environment.AARONNOTE_COPILOT_LANGUAGE_SERVER
        && !environment.AARONNOTE_COPILOT_LANGUAGE_SERVER_MODULE
        && existsSync(serverModule)
        ? { AARONNOTE_COPILOT_LANGUAGE_SERVER_MODULE: serverModule }
        : {}),
    };
  });

  api.log(existsSync(serverModule)
    ? "bundled language server ready for lazy desktop startup"
    : "bundled language server module is missing; runtime fallback discovery remains available");
}
