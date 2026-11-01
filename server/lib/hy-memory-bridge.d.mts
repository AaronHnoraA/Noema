export function hyMemoryConfigured(): boolean;
export function hyMemoryStatus(): { state: string; retryAfterMillis?: number };
export function searchHyMemory(root: string, query: string): Promise<{ state: string; items: any[]; retryAfterMillis?: number }>;
export function recallHyMemory(root: string, query: string): Promise<any[]>;
