export function agentToolGuide(): string;
export function agentApiConnection(): Promise<string>;
export function callAgentApi(channel: string, args?: unknown[], options?: {
  connection?: () => Promise<string>; fetcher?: typeof fetch; timeoutMs?: number;
}): Promise<any>;
export function fullChannel(channel: unknown): unknown;
export function withCallerIdentity(channel: string, args: unknown[], session?: string): unknown[];
