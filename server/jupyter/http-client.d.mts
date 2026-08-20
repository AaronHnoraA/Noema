export interface JupyterHttpClient {
  /** fetch-compatible; accepts either `(url, init)` or a single `Request`. */
  fetch: (input: string | Request, init?: RequestInit) => Promise<Response>;
  cookieHeader(): string;
  /** Current `_xsrf` cookie, if the server issued one. */
  xsrf(): string;
  /** Headers a WebSocket handshake needs to look like the same client. */
  websocketHeaders(): Record<string, string>;
  setHeader(name: string, value?: string): void;
  allowUnauthorized: boolean;
  serverName: string;
}

export function createHttpClient(options?: {
  allowUnauthorized?: boolean;
  headers?: Record<string, string>;
  serverName?: string;
}): JupyterHttpClient;
