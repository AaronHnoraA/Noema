export const WATCH_ADVICE: Record<string, string>;
export function foldWatches(events: any[], now: number): { watches: Map<string, any>; paused: boolean; open: any[]; messages: number };
export function watchSummary(root: string): Promise<any>;
export function piWatch(body?: any, options?: { watcher?: any; now?: number }): Promise<any>;
export function createPiWatcher(options: any): any;
