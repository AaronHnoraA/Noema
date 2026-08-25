import type { EditorView } from "@codemirror/view";
import { renderMarkdownHTML } from "../../../../render-html.ts";
import { MeasuredWidget } from "./measured-widget.ts";
import { shortHash } from "./measured-observer.ts";

export type EmbedQueryDiagnostic = { kind?: string; message?: string };
export type EmbedQueryItem = {
  id: string;
  projectionId?: string;
  rootId?: string;
  file: string;
  path?: string;
  hPath?: string;
  markdown: string;
  markdownTruncated?: boolean;
  kind?: string;
  subType?: string;
  breadcrumb?: Array<{ id?: string; name?: string; type?: string; subType?: string }>;
};
export type EmbedQueryModel = {
  type?: string;
  title?: string;
  evaluationSource?: string;
  items?: EmbedQueryItem[];
  total?: number;
  diagnostics?: EmbedQueryDiagnostic[];
};
export type EmbedQueryRequestDetail = {
  title: string;
  source: string;
  respond: (model: EmbedQueryModel | null, error?: string) => void;
};
export type EmbedQueryOpenDetail = { item: EmbedQueryItem };

function stopEditorEvent(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

function dispatchOpen(element: HTMLElement, item: EmbedQueryItem): void {
  element.dispatchEvent(new CustomEvent<EmbedQueryOpenDetail>("aaronnote:embed-query-open", {
    bubbles: true,
    cancelable: true,
    composed: true,
    detail: { item },
  }));
}

function renderModel(root: HTMLElement, model: EmbedQueryModel): void {
  const content = root.querySelector<HTMLElement>(".cm-embed-query-content");
  const count = root.querySelector<HTMLElement>(".cm-embed-query-count");
  const title = root.querySelector<HTMLElement>(".cm-embed-query-title");
  if (!content || !count || !title) return;
  const items = Array.isArray(model.items) ? model.items : [];
  const diagnostics = Array.isArray(model.diagnostics) ? model.diagnostics : [];
  content.replaceChildren();
  count.textContent = String(Number(model.total ?? items.length));
  title.textContent = String(model.title || "Embedded query");
  root.dataset.evaluationSource = String(model.evaluationSource || "");

  if (diagnostics.length > 0) {
    const message = document.createElement("div");
    message.className = "cm-embed-query-diagnostics";
    message.textContent = diagnostics.map((item) => item.message || item.kind || "Invalid embed query").join(" · ");
    content.append(message);
  }
  for (const item of items) {
    const result = document.createElement("article");
    result.className = "cm-embed-query-result";
    result.dataset.embedResultId = String(item.id || "");
    result.dataset.file = String(item.file || "");
    const header = document.createElement("header");
    header.className = "cm-embed-query-result-header";
    const path = document.createElement("button");
    path.type = "button";
    path.className = "cm-embed-query-result-path";
    path.textContent = String(item.hPath || item.path || item.file || "Result");
    path.title = `Open ${item.file || item.path || "result"}`;
    path.addEventListener("mousedown", (event) => event.stopPropagation());
    path.addEventListener("click", (event) => {
      stopEditorEvent(event);
      dispatchOpen(path, item);
    });
    const kind = document.createElement("span");
    kind.className = "cm-embed-query-result-kind";
    kind.textContent = String(item.subType || item.kind || "block");
    header.append(path, kind);
    const markdown = document.createElement("div");
    markdown.className = "cm-embed-query-result-markdown";
    markdown.innerHTML = renderMarkdownHTML(String(item.markdown || ""));
    result.append(header, markdown);
    if (item.markdownTruncated) {
      const truncated = document.createElement("div");
      truncated.className = "cm-embed-query-truncated";
      truncated.textContent = "Result truncated at 200,000 characters";
      result.append(truncated);
    }
    content.append(result);
  }
  if (items.length === 0 && diagnostics.length === 0) {
    const empty = document.createElement("div");
    empty.className = "cm-embed-query-empty";
    empty.textContent = "No matching blocks";
    content.append(empty);
  }
}

export class EmbedQueryWidget extends MeasuredWidget {
  readonly title: string;
  readonly source: string;
  readonly from: number;
  readonly to: number;

  constructor(title: string, source: string, from: number, to: number) {
    super();
    this.title = title;
    this.source = source;
    this.from = from;
    this.to = to;
  }

  protected measureKey(): string { return `embed-query:${shortHash(`${this.title}\n${this.source}`)}`; }

  protected measureGroupKey(): string { return "embed-query"; }

  protected estimatedHeightFallback(): number { return 260; }

  eq(other: EmbedQueryWidget): boolean {
    return this.title === other.title && this.source === other.source && this.from === other.from && this.to === other.to;
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement("section");
    root.className = "cm-embed-query";
    root.dataset.kind = "embed";
    root.dataset.sourceFrom = String(this.from);
    root.dataset.sourceTo = String(this.to);
    const header = document.createElement("header");
    header.className = "cm-embed-query-header";
    const title = document.createElement("strong");
    title.className = "cm-embed-query-title";
    title.textContent = this.title || "Embedded query";
    const count = document.createElement("span");
    count.className = "cm-embed-query-count";
    count.textContent = "…";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "cm-embed-query-action";
    refresh.textContent = "Refresh";
    const source = document.createElement("button");
    source.type = "button";
    source.className = "cm-embed-query-action";
    source.textContent = "Source";
    header.append(title, count, refresh, source);
    const content = document.createElement("div");
    content.className = "cm-embed-query-content";
    content.textContent = "Loading embedded query…";
    root.append(header, content);

    let requestOrdinal = 0;
    const request = () => {
      const ordinal = ++requestOrdinal;
      content.textContent = "Loading embedded query…";
      const detail: EmbedQueryRequestDetail = {
        title: this.title,
        source: this.source,
        respond: (model, error = "") => {
          if (ordinal !== requestOrdinal || !root.isConnected) return;
          if (!model) {
            content.textContent = error || "Embedded query is unavailable";
            root.dataset.error = "true";
            count.textContent = "!";
            return;
          }
          delete root.dataset.error;
          renderModel(root, model);
        },
      };
      const event = new CustomEvent<EmbedQueryRequestDetail>("aaronnote:embed-query-request", {
        bubbles: true,
        cancelable: true,
        composed: true,
        detail,
      });
      root.dispatchEvent(event);
      if (!event.defaultPrevented) detail.respond(null, "Embedded query provider is unavailable");
    };
    refresh.addEventListener("mousedown", stopEditorEvent);
    refresh.addEventListener("click", (event) => {
      stopEditorEvent(event);
      request();
    });
    source.addEventListener("mousedown", stopEditorEvent);
    source.addEventListener("click", (event) => {
      stopEditorEvent(event);
      view.dispatch({ selection: { anchor: this.from }, scrollIntoView: true });
      view.focus();
    });
    root.addEventListener("mousedown", (event) => event.stopPropagation());
    queueMicrotask(request);
    return this.registerMeasured(root, view);
  }

  ignoreEvent(): boolean { return false; }
}
