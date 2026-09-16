import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Host-owned clock intent journal. It contains references, never project
 * documents. SQLite commits the intent before a source write, so a restart
 * cannot erase a requested stop time. No watcher or periodic work is needed. */
export function createAgendaClockStore(file = ":memory:") {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file, { timeout: 1000 });
  if (file !== ":memory:") chmodSync(file, 0o600);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  db.exec("CREATE TABLE IF NOT EXISTS agenda_clock_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, body TEXT NOT NULL)");
  db.prepare("INSERT OR IGNORE INTO agenda_clock_state VALUES (1, 0, ?)").run(JSON.stringify({ schema: 1, records: [] }));
  const select = db.prepare("SELECT revision, body FROM agenda_clock_state WHERE id=1");
  const update = db.prepare("UPDATE agenda_clock_state SET revision=revision+1, body=? WHERE id=1 AND revision=?");
  function validate(value) {
    if (value?.schema !== 1 || !Array.isArray(value.records) || value.records.length > 4096
        || value.records.some((r) => !r || typeof r.id !== "string" || typeof r.file !== "string"
          || typeof r.scopeId !== "string" || typeof r.root !== "string" || typeof r.from !== "string"
          || !["starting", "running", "stopping"].includes(r.phase))
        || new Set(value.records.map((r) => r.id)).size !== value.records.length) {
      throw new Error("Invalid Agenda clock journal; source files have not been changed");
    }
    return value;
  }
  return {
    read() {
      const row = select.get();
      return { revision: row.revision, ...validate(JSON.parse(row.body)) };
    },
    commit(state, records) {
      const body = JSON.stringify(validate({ schema: 1, records }));
      if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error("Agenda clock journal exceeds 8 MiB");
      if (Number(update.run(body, state.revision).changes) !== 1) {
        throw Object.assign(new Error("Agenda clock journal changed in another host; refresh before retrying"), { statusCode: 409 });
      }
      return { revision: state.revision + 1, schema: 1, records: structuredClone(records) };
    },
    close() { db.close(); },
  };
}
