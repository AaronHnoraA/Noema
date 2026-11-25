import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { isEscapedCommandStart, scanInlineCommands } from "../../../../command-syntax.ts";
import { readInlineReading, renderInlineReading } from "../../../../document-inline-reading.ts";
import { renderMarkdownInlineHTML } from "../../../../render-html.ts";
import { dispatchConstructEdit, inlineConstruct } from "../constructs/index.ts";
import { enhanceRenderedMarkdown } from "./block-extras.ts";
import { editorSpoilerOpen, rememberEditorSpoiler } from "../../spoilers.ts";
import { MeasuredWidget } from "./measured-widget.ts";

type Reading = NonNullable<ReturnType<typeof readInlineReading>>;

function escapeInlineText(text: string): string {
  const temporary = document.createElement("span");
  temporary.textContent = text;
  return temporary.innerHTML.replace(/"/g, "&quot;");
}

class InlineReadingWidget extends MeasuredWidget {
  readonly reading: Reading;
  readonly source: string;

  constructor(reading: Reading, source: string) {
    super();
    this.reading = reading;
    this.source = source;
  }

  protected measureKey(): string { return ""; }
  protected get measuredBlock(): boolean { return false; }
  eq(other: InlineReadingWidget): boolean { return this.source === other.source; }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement("span");
    root.className = "cm-inline-reading-widget";
    root.innerHTML = renderInlineReading(this.reading, renderMarkdownInlineHTML, escapeInlineText);
    const toggle = root.querySelector<HTMLInputElement>(".noema-inline-toggle");
    if (toggle) {
      queueMicrotask(() => {
        if (!view.dom.contains(root)) return;
        toggle.checked = editorSpoilerOpen(view, view.posAtDOM(root, -1));
      });
      toggle.addEventListener("change", () => {
        rememberEditorSpoiler(view, view.posAtDOM(root, -1), toggle.checked);
        view.requestMeasure();
      });
    }
    enhanceRenderedMarkdown(root, view);
    root.addEventListener("dblclick", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (view.state.readOnly || target?.closest("a, label, input")) return;
      event.preventDefault();
      event.stopPropagation();
      dispatchConstructEdit(view, { selection: { anchor: view.posAtDOM(root, -1) + 2 } });
      view.focus();
    });
    return root;
  }

  ignoreEvent(): boolean { return true; }
}

export const inlineReadingExtension = inlineConstruct({
  kind: "inline-reading",
  role: "structure",
  reveal: "caret-edge",
  maxPerViewport: 192,
  *match(line, state) {
    if (!line.text.includes("@@")) return;
    for (const command of scanInlineCommands(line.text)) {
      if (isEscapedCommandStart(line.text, command.fullFrom)) continue;
      const reading = readInlineReading(command);
      if (!reading) continue;
      if (line.text.lastIndexOf("<!--", command.fullFrom) > line.text.lastIndexOf("-->", command.fullFrom)) continue;
      const from = line.from + command.fullFrom;
      let node = syntaxTree(state).resolve(from, 1);
      while (node.parent && node.name !== "HTMLBlock") node = node.parent;
      if (node.name === "HTMLBlock") continue;
      yield { from, to: line.from + command.fullTo,
        widget: () => new InlineReadingWidget(reading, line.text.slice(command.fullFrom, command.fullTo)) };
    }
  },
});
