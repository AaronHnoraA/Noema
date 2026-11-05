export interface MarginNoteConnection { url: string; token: string }
export function validateConnection(config: unknown): MarginNoteConnection;
export function connection(): Promise<MarginNoteConnection>;
export function call(path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>>;
export function apiReference(query?: string, offset?: number, limit?: number): Promise<Record<string, unknown>>;
