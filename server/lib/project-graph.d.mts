export const PHASE_ADVICE: Record<string, string>;
export const FINDING_ADVICE: Record<string, string>;
export function resolveGraphRoot(start: string): Promise<string>;
export function parseTask(text: string): any;
export function serializeTask(task: any): string;
export function foldJournal(events: any[]): Map<string, any>;
export function diagnose(graph: any): any;
export function projectGraph(body?: Record<string, unknown>): Promise<any>;
export function renderGraph(result: any): string;
