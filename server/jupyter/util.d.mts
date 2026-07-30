// Ambient types for the ported vscode-jupyter async helpers.

export function noop(): void;

export interface Logger {
  error(message: string, ex?: unknown): void;
  warn(message: string): void;
}

export function makeLogger(stderr?: NodeJS.WritableStream): Logger;

export function sleep(timeoutMs: number): Promise<number>;

export function raceTimeout<T>(timeoutMs: number, defaultValue: T, ...promises: Promise<T>[]): Promise<T>;

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolved: boolean;
  readonly rejected: boolean;
  readonly completed: boolean;
  readonly value: T | undefined;
  resolve(value?: T): void;
  reject(reason?: unknown): void;
}

export function createDeferred<T = unknown>(): Deferred<T>;
