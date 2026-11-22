export function createKernelWikiIndexBuilder(options: {
  kernel: () => { ready?: boolean; baseUrl?: string; box?: { id?: string; root?: string } } | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): (root: string, options?: { full?: boolean }) => Promise<{ index: unknown; mode: string; reason: string; changed: number; elapsedMs: number }>;
