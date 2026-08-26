export const NOEMA_PROTOCOL_SCHEME: "noema";
export const MAX_NOEMA_PROTOCOL_URL_BYTES: number;

export type NoemaProtocolTarget = {
  action: "open-route";
  route: "/wiki" | "/wiki?view=graph";
  disposition: "" | "new";
} | {
  action: "open-note";
  file: string;
  scope: "absolute" | "workspace";
  workspaceRoot: string;
  hash: string;
  dom: string;
  disposition: "" | "new";
};

export function noemaProtocolUrlFromArgv(argv?: unknown[]): string;
export function protocolPathWithin(root: string, target: string, platform?: NodeJS.Platform): boolean;
export function parseNoemaProtocolUrl(value: unknown, options?: {
  workspaceRoot?: unknown;
  platform?: NodeJS.Platform;
}): NoemaProtocolTarget;
export function verifyNoemaProtocolTarget(target: NoemaProtocolTarget, options?: {
  platform?: NodeJS.Platform;
  realpath?: (path: string) => string;
  stat?: (path: string) => { isFile(): boolean };
}): NoemaProtocolTarget;
