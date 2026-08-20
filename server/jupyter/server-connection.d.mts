import type { ServerConnection } from "@jupyterlab/services";
import type { JupyterHttpClient } from "./http-client.d.mts";

export function createServerSettings(options: {
  baseUrl: string;
  wsUrl: string;
  client: JupyterHttpClient;
  token?: string;
}): ServerConnection.ISettings;
