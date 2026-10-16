import { MeasuredWidget } from "./measured-widget.ts";
import { parseLeanPlaceholderLine } from "../../../../../shared/lean-placeholder.mjs";
import { inlineConstruct } from "../constructs/index.ts";

export type LeanLspAction = "definition" | "declaration" | "typeDefinition" | "implementation" | "references" | "hover";
export type LeanEditAction =
  | "toggleLineComment"
  | "toggleBlockComment"
  | "duplicateUp"
  | "duplicateDown"
  | "moveUp"
  | "moveDown"
  | "joinLines"
  | "deleteTrailingWhitespace"
  | "indent"
  | "outdent";
export type LeanPosition = { line: number; character: number };
export type LeanLocation = {
  uri?: string;
  file: string;
  range: { start: LeanPosition; end: LeanPosition };
  summary: string;
};
export type LeanEditorController = {
  id: string;
  notePath: string;
  leanPath: string;
  tag: string;
  selector: string;
  runLspAction(action: LeanLspAction, position?: LeanPosition): Promise<void>;
  runEditAction(action: LeanEditAction): void;
  openExternal(position?: LeanPosition): Promise<void>;
  jumpTo(line: number, character: number): void;
};
export type LeanLocationsPicker = (locations: LeanLocation[], onPick: (location: LeanLocation) => void) => void;

type LeanPlaceholderLine = {
  commandFrom: number;
  commandTo: number;
  selector: string;
  tag: string;
};

const leanControllers = new Map<string, LeanEditorController>();
let activeLeanControllerId = "";

export function registerLeanController(controller: LeanEditorController): void {
  leanControllers.set(controller.id, controller);
}

export function unregisterLeanController(id: string): void {
  leanControllers.delete(id);
  if (activeLeanControllerId === id) activeLeanControllerId = "";
}

export function setActiveLeanController(id: string): void {
  if (leanControllers.has(id)) activeLeanControllerId = id;
}

export function getLeanController(id: string): LeanEditorController | null {
  return leanControllers.get(id) ?? null;
}

export function activeLeanController(): LeanEditorController | null {
  return activeLeanControllerId ? leanControllers.get(activeLeanControllerId) ?? null : null;
}

export function setLeanLocationsPicker(picker: LeanLocationsPicker | null): void {
  void picker;
}

export function clearLeanSnippetCache(): void {
  // The Emacs-hosted Noema build does not keep a browser-side Lean snippet cache.
}

class LeanPlaceholderWidget extends MeasuredWidget {
  spec: LeanPlaceholderLine;
  from: number;
  to: number;

  constructor(spec: LeanPlaceholderLine, from: number, to: number) {
    super();
    this.spec = spec;
    this.from = from;
    this.to = to;
  }

  protected measureKey(): string { return ""; }
  protected get measuredBlock(): boolean { return false; }

  eq(other: LeanPlaceholderWidget): boolean {
    return this.spec.tag === other.spec.tag
      && this.spec.selector === other.spec.selector
      && this.from === other.from
      && this.to === other.to;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-lean-placeholder-widget inline-command-token";
    wrap.dataset.cmSourceFrom = String(this.from);
    wrap.dataset.cmSourceTo = String(this.to);
    wrap.dataset.cmOpenSource = "true";
    wrap.textContent = this.spec.selector
      ? `Lean ${this.spec.selector} [${this.spec.tag}]`
      : `Lean [${this.spec.tag}]`;
    return wrap;
  }

  ignoreEvent(): boolean { return false; }
}

export const leanPlaceholderPreviewExtension = inlineConstruct({
  kind: "lean-placeholder",
  reveal: "edge",
  // An `@@` command: Vim opens it as text, like every other command.
  role: "structure",
  maxPerViewport: 2_000,
  *match(line) {
    if (!line.text.includes("@@lean4")) return;
    const parsed = parseLeanPlaceholderLine(line.text) as LeanPlaceholderLine | null;
    if (!parsed) return;
    const from = line.from + parsed.commandFrom;
    const to = line.from + parsed.commandTo;
    yield { from, to, widget: () => new LeanPlaceholderWidget(parsed, from, to) };
  },
});

export const leanPlaceholderEditingExtension = [];
