export function agentApiConnection(): Promise<string>;
export function callAgentApi(channel: string, args?: unknown[], options?: {
  connection?: () => Promise<string>; fetcher?: typeof fetch;
}): Promise<any>;
export function fullChannel(channel: unknown): unknown;
