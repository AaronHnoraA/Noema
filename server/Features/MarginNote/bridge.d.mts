export type NativeTask = { id: string; code: string; args: unknown; deadline: number };
export type ExecutionResult = { ok: boolean; requestId: string; sessionId: string; state: string;
  execution?: "unknown" | "not_started"; value?: unknown; lateResult?: unknown; error?: unknown; logs?: unknown[] };
export interface MarginNoteBridge {
  list(): { ok: true; sessions: Array<{ id: string; info: unknown; lastSeen: number; running: string | null; queued: number }> };
  submit(input: { code: string; args?: unknown; sessionId?: string; timeoutMs?: number; requestId?: string }): Promise<ExecutionResult>;
  poll(input: { sessionId: string; info?: Record<string, unknown>; completed?: { id: string; ok: boolean; value?: unknown; error?: unknown; logs?: unknown[] } }, signal?: AbortSignal): Promise<{ ok: true; task: NativeTask | null }>;
  request(id: string): ExecutionResult | { ok: true; requestId: string; state: string };
  disconnect(id: string): void;
  heartbeat(input: { sessionId: string; info?: Record<string, unknown> }): { ok: boolean };
  close(): void;
}
export function ensureMarginNoteToken(stateRoot: string): Promise<string>;
export function createMarginNoteBridge(options?: { pollMs?: number; staleMs?: number }): MarginNoteBridge;
