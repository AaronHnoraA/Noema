import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Recent-note and cursor-position domain logic.
 *
 * Filesystem policy is injected: the host decides which files are legal and
 * how writes become atomic/self-write-aware. This keeps session semantics
 * independently testable without importing the full runtime.
 */
export class SessionManager {
  constructor({ stateRoot, resolveFile, writeFile }) {
    this.stateRoot = stateRoot;
    this.resolveFile = resolveFile;
    this.writeFile = writeFile;
    this.cursorWriteTail = Promise.resolve();
  }

  normalizeRecentNotes(entries) {
    if (!Array.isArray(entries)) return [];
    const byFile = new Map();
    for (const item of entries) {
      const file = item && typeof item.file === "string" ? item.file : "";
      const openedAt = item && typeof item.openedAt === "number" ? item.openedAt : NaN;
      if (!file || !Number.isFinite(openedAt)) continue;
      let safe;
      try {
        safe = this.resolveFile(file);
      } catch {
        continue;
      }
      const current = byFile.get(safe);
      if (!current || openedAt > current.openedAt) byFile.set(safe, { file: safe, openedAt });
    }
    return [...byFile.values()].sort((a, b) => b.openedAt - a.openedAt).slice(0, 24);
  }

  async readRecentNotes() {
    try {
      const raw = await readFile(join(this.stateRoot, "recent.json"), "utf8");
      return this.normalizeRecentNotes(JSON.parse(raw));
    } catch {
      return [];
    }
  }

  async touchRecentNote(file, openedAt = Date.now()) {
    const safe = this.resolveFile(file);
    const recent = await this.readRecentNotes();
    const next = this.normalizeRecentNotes([{ file: safe, openedAt }, ...recent]);
    await this.writeFile(
      join(this.stateRoot, "recent.json"),
      `${JSON.stringify(next, null, 2)}\n`,
      "utf8",
    );
    return next;
  }

  normalizeCursorPositions(entries) {
    if (!Array.isArray(entries)) return [];
    const bySlot = new Map();
    for (const item of entries) {
      const file = item && typeof item.file === "string" ? item.file : "";
      if (!file) continue;
      let safe;
      try {
        safe = this.resolveFile(file);
      } catch {
        continue;
      }
      const from = item && typeof item.from === "number" && Number.isFinite(item.from) ? Math.max(0, item.from) : 0;
      const to = item && typeof item.to === "number" && Number.isFinite(item.to) ? Math.max(0, item.to) : from;
      const scrollY = item && typeof item.scrollY === "number" && Number.isFinite(item.scrollY) ? Math.max(0, item.scrollY) : 0;
      const updatedAt = item && typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) ? item.updatedAt : 0;
      const mode = item && item.mode === "source" ? "source" : "markdown";
      // Emacs split panes have stable client ids. Keep their cursor slots
      // independent so focusing/saving one pane cannot replace the other
      // pane's remembered location. Entries without a client remain the
      // legacy/global desktop slot and preserve backwards compatibility.
      const client = item && typeof item.client === "string"
        ? item.client.trim().slice(0, 256)
        : "";
      const slot = `${safe}\0${client}`;
      const current = bySlot.get(slot);
      if (!current || updatedAt > current.updatedAt) {
        bySlot.set(slot, {
          file: safe,
          ...(client ? { client } : {}),
          mode,
          from,
          to,
          scrollY,
          updatedAt,
        });
      }
    }
    return [...bySlot.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 240);
  }

  async readCursorPositions() {
    try {
      const raw = await readFile(join(this.stateRoot, "positions.json"), "utf8");
      return this.normalizeCursorPositions(JSON.parse(raw));
    } catch {
      return [];
    }
  }

  async touchCursorPosition(body) {
    const operation = this.cursorWriteTail.then(async () => {
      const safe = this.resolveFile(body.file);
      const updatedAt = Number(body.updatedAt) || Date.now();
      const scoped = { ...body, file: safe, updatedAt };
      const current = await this.readCursorPositions();
      // Keep an unscoped last-used slot as a migration/new-window fallback.
      // Exact client slots still win when the same pane is restored.
      const fallback = scoped.client
        ? { ...scoped, client: undefined }
        : null;
      const next = this.normalizeCursorPositions([
        scoped,
        ...(fallback ? [fallback] : []),
        ...current,
      ]);
      await this.writeFile(
        join(this.stateRoot, "positions.json"),
        `${JSON.stringify(next, null, 2)}\n`,
        "utf8",
      );
      return next;
    });
    // A failed filesystem write must not poison every later cursor save.
    this.cursorWriteTail = operation.catch(() => undefined);
    return operation;
  }
}
