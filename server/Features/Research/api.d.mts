export type ResearchApiService = Record<
  string,
  (body?: Record<string, any>) => Promise<Record<string, any>>
>;

export function createResearchApiHandlers(
  service: ResearchApiService,
): Record<string, (body?: unknown) => Promise<{ type: "research"; ok: true; [key: string]: any }>>;
