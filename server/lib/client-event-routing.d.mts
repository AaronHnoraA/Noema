export type ClientLifecycleCommand = "pause" | "resume";

export const MAX_CLIENT_LIFECYCLE_STATES: 256;

export function normalizeEventClient(value: unknown): string;
export function eventTargetsClient(payload: unknown, client: unknown): boolean;
export function rememberClientLifecycle(
  states: Map<string, ClientLifecycleCommand>,
  payload: unknown,
): boolean;
export function forgetClientLifecycle(
  states: Map<string, ClientLifecycleCommand>,
  client: unknown,
): boolean;
export function clientLifecycleReplay(
  states: Map<string, ClientLifecycleCommand>,
  client: unknown,
): {
  command: ClientLifecycleCommand;
  targetClient: string;
  client: string;
  replay: true;
} | null;
