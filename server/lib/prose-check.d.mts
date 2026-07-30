export type ExternalProseDiagnostic = {
  source: "languagetool";
  from: number;
  to: number;
  severity: "info" | "warning" | "error";
  message: string;
  rule?: string;
  word?: string;
  suggestions: string[];
};

export function parseLanguageToolDiagnostics(stdout: string, masked: string, language?: string): ExternalProseDiagnostic[];
export function acceptProseWord(word: string): Promise<{ ok: boolean; word?: string; message?: string }>;
export function cancelExternalProseCheck(requestId: string): { ok: true; cancelled: boolean; requestId: string };
export function cancelAllExternalProseChecks(reason?: string): { ok: true; cancelled: number };
export function cancelExternalProseChecksForClient(clientId: string, reason?: string): { ok: true; cancelled: number };
export function probeLanguageTool(settings?: Record<string, unknown>): Promise<{
  ok: true;
  serverUrl: string;
  latencyMs: number;
  version: string;
}>;
export function runExternalProseChecks(body?: {
  requestId?: string;
  file?: string;
  content?: string;
  ranges?: Array<{ from: number; to: number }>;
  segments?: Array<{ from: number; text: string }>;
  totalChars?: number;
  allowLocalFallback?: boolean;
  interactive?: boolean;
}): Promise<Record<string, unknown>>;
