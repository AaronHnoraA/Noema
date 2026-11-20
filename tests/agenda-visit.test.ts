import { expect, test } from "@voidzero-dev/vite-plus-test";
import { createAgendaVisitHandler } from "../server/lib/agenda-navigation.mjs";

test("Agenda visits keep the originating page and discard superseded lookups", async () => {
  const pending: Array<(todo: Record<string, unknown>) => void> = [], events: unknown[] = [];
  const visit = createAgendaVisitHandler({
    lookup: () => new Promise((resolve) => pending.push(resolve)),
    notify: (event: unknown) => events.push(event),
  });
  const old = visit({ originClient: "agenda", uid: "old" });
  const next = visit({ originClient: "agenda", uid: "next" });
  pending[1]({ file: "/next.md", uid: "next" });
  expect(await next).toEqual({ ok: true });
  pending[0]({ file: "/old.md", uid: "old" });
  expect(await old).toEqual({ ok: true, superseded: true });
  expect(events).toEqual([{ type: "agenda-visit", payload: { file: "/next.md", uid: "next", originClient: "agenda" } }]);
});

test("separate Agenda pages do not supersede one another", async () => {
  const events: unknown[] = [];
  const visit = createAgendaVisitHandler({ lookup: async (body) => body, notify: (event: unknown) => events.push(event) });
  await Promise.all([visit({ originClient: "one", uid: "a" }), visit({ originClient: "two", uid: "b" })]);
  expect(events).toHaveLength(2);
});
