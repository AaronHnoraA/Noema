export type ApiHandler = (...args: never[]) => unknown | Promise<unknown>;

export class ApiRouter {
  register(handlers: Record<string, ApiHandler>, owner?: string): this;
  has(channel: string): boolean;
  channels(): string[];
  describe(channel: string): { channel: string; arguments: string; implementation: string; [key: string]: unknown };
  call(channel: string, args?: unknown[]): Promise<unknown>;
}
