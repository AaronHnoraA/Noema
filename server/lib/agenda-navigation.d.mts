export type AgendaVisitBody = Record<string, unknown>;
export function createAgendaVisitHandler(deps: {
  lookup: (body: AgendaVisitBody) => Promise<AgendaVisitBody>;
  notify: (event: { type: "agenda-visit"; payload: AgendaVisitBody }) => void;
}): (body?: AgendaVisitBody) => Promise<{ ok: true; superseded?: true }>;
