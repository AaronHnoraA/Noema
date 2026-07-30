export type ApiHandler = (...args: never[]) => unknown | Promise<unknown>;

export class ApiRouter {
  register(handlers: Record<string, ApiHandler>, owner?: string): this;
  has(channel: string): boolean;
  channels(): string[];
  call(channel: string, args?: unknown[]): Promise<unknown>;
}
