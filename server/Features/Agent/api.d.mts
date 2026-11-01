import type { ApiRouter } from "../../infrastructure/api-router.mjs";
export type Position = number | { line: number; column: number };
export interface ProposalEdit { from: Position; to: Position; oldText: string; newText: string; title?: string }
export function proposeMarkdown(source: string, edits: readonly ProposalEdit[]): string;
export function createAgentApiHandlers(deps: {
  router: ApiRouter; call: (channel: string, args?: any[]) => Promise<any>;
}): Record<string, (...args: any[]) => any>;
