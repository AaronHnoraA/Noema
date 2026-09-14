import type { ResearchNotebookService } from "../../lib/research-notebook.mjs";

export function createResearchApiHandlers(
  service: ResearchNotebookService,
): Record<string, (body?: unknown) => Promise<{ type: "research"; ok: true; [key: string]: any }>>;
