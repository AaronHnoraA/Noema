import type { JupyterHttpClient } from "./http-client.d.mts";

export type JupyterServerAuthKind = "token" | "password" | "hub" | "none";

export interface JupyterServerConfig {
  url: string;
  kind?: "server" | "gateway";
  auth?: JupyterServerAuthKind;
  token?: string;
  password?: string;
  /** JupyterHub user whose single-user server to use. */
  user?: string;
  allowUnauthorized?: boolean;
  /** TLS SNI / Host override, for a URL that is a local forward of a named host. */
  serverName?: string;
}

/** Strip `/lab`, `/tree`, and a `?token=` query; guarantee a trailing slash. */
export function normalizeBaseUrl(value: string): { baseUrl: string; token: string };

export function websocketUrlFor(baseUrl: string): string;

export function connectToServer(options: JupyterServerConfig & {
  stderr?: NodeJS.WritableStream;
}): Promise<{ baseUrl: string; wsUrl: string; client: JupyterHttpClient; token: string }>;
