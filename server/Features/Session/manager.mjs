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
    const byFile = new Map();
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
      const current = byFile.get(safe);
      if (!current || updatedAt > current.updatedAt) {
        byFile.set(safe, { file: safe, mode, from, to, scrollY, updatedAt });
      }
    }
    return [...byFile.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 240);
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
    const safe = this.resolveFile(body.file);
    const current = await this.readCursorPositions();
    const next = this.normalizeCursorPositions([{
      ...body,
      file: safe,
      updatedAt: Number(body.updatedAt) || Date.now(),
    }, ...current]);
    await this.writeFile(
      join(this.stateRoot, "positions.json"),
      `${JSON.stringify(next, null, 2)}\n`,
      "utf8",
    );
    return next;
  }
}
