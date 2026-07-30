import type { ViewUpdate } from "@codemirror/view";

import type { Editor } from "../src/lib.ts";
import { getKatexMacros, getKatexMacrosVersion } from "../src/katex-macros.ts";
import type { SnippetSummary } from "./types.ts";

const SCAN_CHUNK_CHARS = 16 * 1024;
const IDLE_BUDGET_MS = 8;
const DOCUMENT_COMMAND_LIMIT = 512;

type ScanState = {
  inlineMath: boolean;
  displayMath: boolean;
  fence: "```" | "~~~" | "";
  lineStart: boolean;
};

function escapedAt(text: string, index: number): boolean {
  let count = 0;
  for (let pos = index - 1; pos >= 0 && text[pos] === "\\"; pos--) count += 1;
  return count % 2 === 1;
}

export function scanMathCommandChunk(
  text: string,
  state: ScanState = { inlineMath: false, displayMath: false, fence: "", lineStart: true },
  counts = new Map<string, number>(),
): { state: ScanState; counts: Map<string, number> } {
  const next = { ...state };
  for (let pos = 0; pos < text.length;) {
    if (next.lineStart && !next.inlineMath && !next.displayMath) {
      const marker = text.slice(pos).match(/^[ \t]*(```|~~~)/)?.[1] as "```" | "~~~" | undefined;
      if (marker) {
        next.fence = next.fence === marker ? "" : next.fence || marker;
      }
    }
    const ch = text[pos]!;
    if (ch === "\n") {
      next.lineStart = true;
      pos += 1;
      continue;
    }
    if (next.lineStart && ch !== " " && ch !== "\t") next.lineStart = false;
    if (next.fence || ch !== "\\" || escapedAt(text, pos)) {
      pos += 1;
      continue;
    }
    const marker = text[pos + 1] ?? "";
    if (!next.displayMath && marker === "(") {
      next.inlineMath = true;
      pos += 2;
      continue;
    }
    if (next.inlineMath && marker === ")") {
      next.inlineMath = false;
      pos += 2;
      continue;
    }
    if (!next.inlineMath && marker === "[") {
      next.displayMath = true;
      pos += 2;
      continue;
    }
    if (next.displayMath && marker === "]") {
      next.displayMath = false;
      pos += 2;
      continue;
    }
    if (!next.inlineMath && !next.displayMath) {
      pos += 1;
      continue;
    }
    const command = text.slice(pos).match(/^\\[A-Za-z]+/)?.[0];
    if (!command) {
      pos += 2;
      continue;
    }
    counts.set(command, (counts.get(command) ?? 0) + 1);
    pos += command.length;
  }
  return { state: next, counts };
}

function requestIdle(run: (deadline: { timeRemaining: () => number }) => void): number {
  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    return window.requestIdleCallback(run, { timeout: 180 });
  }
  return globalThis.setTimeout(() => run({ timeRemaining: () => IDLE_BUDGET_MS }), 16) as unknown as number;
}

function cancelIdle(handle: number): void {
  if (typeof window !== "undefined" && typeof window.cancelIdleCallback === "function") {
    window.cancelIdleCallback(handle);
  } else {
    globalThis.clearTimeout(handle);
  }
}

export class MathSnippetIndex {
  private readonly editor: Editor;
  private counts = new Map<string, number>();
  private scanHandle = 0;
  private generation = 0;
  private version = 0;
  private candidateCacheKey = "";
  private candidateCache: SnippetSummary[] = [];
  private readonly unsubscribe: () => void;
  private readonly unsubscribeReset: () => void;

  constructor(editor: Editor) {
    this.editor = editor;
    this.unsubscribe = editor.onViewUpdate((update) => this.observe(update));
    this.unsubscribeReset = editor.onDocumentReset(() => this.scheduleRebuild());
    this.scheduleRebuild();
  }

  destroy(): void {
    this.generation += 1;
    this.unsubscribe();
    this.unsubscribeReset();
    if (this.scanHandle) cancelIdle(this.scanHandle);
    this.scanHandle = 0;
  }

  frequencies(): ReadonlyMap<string, number> {
    return this.counts;
  }

  candidates(): readonly SnippetSummary[] {
    const macros = getKatexMacros();
    const cacheKey = `${getKatexMacrosVersion()}:${this.version}`;
    if (cacheKey === this.candidateCacheKey) return this.candidateCache;
    const commands = new Set<string>(Object.keys(macros));
    for (const [command] of [...this.counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, DOCUMENT_COMMAND_LIMIT)) commands.add(command);
    this.candidateCache = [...commands].sort().map((command) => {
      const expansion = macros[command];
      const arity = expansion
        ? Math.max(0, ...[...expansion.matchAll(/#([1-9])/g)].map((match) => Number(match[1])))
        : 0;
      const args = Array.from({ length: arity }, (_, index) => `{\${${index + 1}:arg${index + 1}}}`).join("");
      const provider = this.counts.has(command) ? "document" : "katex";
      return {
        id: `${provider}:${command}`,
        key: command,
        name: provider === "document" ? `${command} · current note` : `${command} · KaTeX macro`,
        description: expansion || "Command used in the current note",
        mode: "tex-mode",
        context: "math-command",
        provider,
        priority: provider === "document" ? 440 : 400,
        weight: this.counts.get(command) ?? 0,
        body: `${command}${args}$0`,
        browserCompatible: true,
      } satisfies SnippetSummary;
    });
    this.candidateCacheKey = cacheKey;
    return this.candidateCache;
  }

  private observe(update: ViewUpdate): void {
    if (!update.docChanged) return;
    // Hot-path work remains proportional to inserted text. Exact counts are
    // rebuilt later in cancellable idle slices.
    for (const transaction of update.transactions) {
      transaction.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
        if (inserted.length > SCAN_CHUNK_CHARS) return;
        scanMathCommandChunk(inserted.toString(), undefined, this.counts);
      });
    }
    this.version += 1;
    this.scheduleRebuild();
  }

  private scheduleRebuild(): void {
    const generation = ++this.generation;
    if (this.scanHandle) cancelIdle(this.scanHandle);
    const doc = this.editor.view.state.doc;
    let position = 0;
    let scanState: ScanState = { inlineMath: false, displayMath: false, fence: "", lineStart: true };
    const nextCounts = new Map<string, number>();
    const scan = (deadline: { timeRemaining: () => number }): void => {
      if (generation !== this.generation) return;
      const started = performance.now();
      let firstChunk = true;
      while (position < doc.length && (firstChunk || (
        performance.now() - started < IDLE_BUDGET_MS && deadline.timeRemaining() > 0
      ))) {
        firstChunk = false;
        const to = Math.min(doc.length, position + SCAN_CHUNK_CHARS);
        const result = scanMathCommandChunk(doc.sliceString(position, to), scanState, nextCounts);
        scanState = result.state;
        position = to;
      }
      if (position < doc.length) {
        this.scanHandle = requestIdle(scan);
        return;
      }
      this.scanHandle = 0;
      this.counts = nextCounts;
      this.version += 1;
      this.candidateCacheKey = "";
    };
    this.scanHandle = requestIdle(scan);
  }
}
