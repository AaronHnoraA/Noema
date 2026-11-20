import type { TodoItem } from "./api-client.ts";
import { scanCommentAnchors } from "../shared/comment-anchors.mjs";
import { planningDocumentExcludedRanges } from "../shared/planning-document.mjs";

export type AgendaDocument = { contentRevision?: string; todos?: TodoItem[] };
export type AgendaTarget = { from: number; to: number };
export type AgendaNavigationDeps = {
  file: () => string;
  content: () => string;
  selection: () => unknown;
  inspect: (body: { file: string; content: string }) => Promise<AgendaDocument>;
  reveal: (range: AgendaTarget) => void;
  active?: () => boolean;
};

// Host-native and local Remote identities can name the same macOS path. Keep
// the complete path and every remote target; suffix matches can select another note.
function documentIdentity(file: string): string {
  const path = file.replace(/^\/fs:local:/, "");
  return path.replace(/^\/private\/(tmp|var)(?=\/|$)/, "/$1");
}

/** Resolve only live parser results; source text in a code example is not a task. */
export function resolveAgendaTarget(content: string, snapshot: AgendaDocument, record: TodoItem): AgendaTarget {
  const id = String(record.sourceRef?.id || record.id || "");
  if (record.sourceKind === "comment" || record.sourceKind === "comment-reference") {
    const excluded = planningDocumentExcludedRanges(content);
    const literal = (position: number) => excluded.some((range) => range.from <= position && position < range.to);
    const anchors = scanCommentAnchors(content).filter((anchor) => "#" + anchor.id === id
      && !literal(anchor.from) && !literal(anchor.textTo));
    if (!anchors.length && record.sourceKind === "comment-reference") {
      const quote = typeof record.quote === "string" ? record.quote : "";
      const from = quote ? content.indexOf(quote) : -1;
      if (from < 0) throw new Error("Reference is no longer in this note; open its source and refresh the task");
      if (from !== content.lastIndexOf(quote)) throw new Error("Ambiguous reference; its quoted text occurs more than once");
      return { from, to: from + quote.length };
    }
    if (anchors.length !== 1) throw new Error(anchors.length ? "Ambiguous comment anchor" : "Comment is no longer in this note");
    return { from: anchors[0].textFrom, to: anchors[0].textTo };
  }
  let matches = (snapshot.todos || []).filter((task) => id.startsWith("#")
    ? task.id === id : typeof record.source === "string" && record.source.length > 0 && task.source === record.source);
  if (matches.length > 1 && !id.startsWith("#") && record.sourceRef?.revision
      && record.sourceRef.revision === snapshot.contentRevision) {
    matches = matches.filter((task) => task.index === (record.sourceRef?.index ?? record.index));
  }
  if (matches.length !== 1) throw new Error(matches.length ? "Ambiguous task; assign a stable task ID" : "Task is no longer in this note; refresh Agenda");
  const task = matches[0], from = task.index, source = task.source;
  if (typeof from !== "number" || !Number.isSafeInteger(from) || from < 0 || typeof source !== "string" || !source
      || content.slice(from, from + source.length) !== source) throw new Error("Task position does not match the live document");
  return { from, to: from + source.length };
}

/** A late result cannot move a newer document, selection or navigation. No writes. */
export function createAgendaNavigator(deps: AgendaNavigationDeps): ((record: TodoItem) => Promise<boolean>) & { cancel: () => void } {
  let generation = 0;
  const navigate = async (record: TodoItem) => {
    const request = ++generation, file = deps.file(), content = deps.content(), selection = deps.selection();
    if (deps.active?.() === false) return false;
    if (!file || documentIdentity(String(record.file || "")) !== documentIdentity(file)) {
      throw new Error("Agenda request belongs to a different note");
    }
    const current = () => request === generation && deps.file() === file && deps.content() === content
      && deps.selection() === selection && deps.active?.() !== false;
    let snapshot: AgendaDocument;
    try { snapshot = record.sourceKind === "comment" || record.sourceKind === "comment-reference" ? {} : await deps.inspect({ file, content }); }
    catch (error) { if (!current()) return false; throw error; }
    if (!current()) return false;
    deps.reveal(resolveAgendaTarget(content, snapshot, record));
    return true;
  };
  return Object.assign(navigate, { cancel: () => { generation++; } });
}
