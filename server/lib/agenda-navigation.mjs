/** Guard only pending read-only lookups; no task state or session registry. */
export function createAgendaVisitHandler({ lookup, notify }) {
  const pending = new Map();
  return async (body = {}) => {
    const client = typeof body.originClient === "string" ? body.originClient : "";
    const request = {};
    pending.set(client, request);
    try {
      const todo = await lookup(body);
      if (pending.get(client) !== request) return { ok: true, superseded: true };
      notify({ type: "agenda-visit", payload: { ...todo, ...(client ? { originClient: client } : {}) } });
      return { ok: true };
    } finally {
      if (pending.get(client) === request) pending.delete(client);
    }
  };
}
