export function readJournal(file: string): Promise<{ events: any[]; torn: number }>;
export function appendEvent(file: string, event: unknown): Promise<void>;
export function withLock<T>(directory: string, name: string, work: () => Promise<T>): Promise<T>;
export function ensureAgentDirectory(root: string, name: string): Promise<void>;
export function atomicWrite(file: string, text: string): Promise<void>;
