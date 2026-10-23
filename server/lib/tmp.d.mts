export function configureTmpRoot(root: string): string;
export function noemaTmpRoot(): string;
export function encodeOriginalPathToTmpName(filePath: string): string;
export function runtimeTmpDir(kind?: string): Promise<string>;
export function runtimeTmpFile(kind: string, originalPath: string, suffix?: string): Promise<string>;
export function runtimeMkdtemp(kind: string, originalPath?: string): Promise<string>;
export function sweepRuntimeTmp(options?: { ttlMs?: number; maxEntries?: number }): Promise<{ scanned: number; removed: number }>;
