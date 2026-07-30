import { renderMarkdownHTML } from "../src/render-html.ts";
import type { Inbound, NoteSummary } from "./types.ts";
import { Epoch } from "../src/async-epoch.ts";

export type LinkPreviewTarget = {
  href: string;
  note?: NoteSummary;
  equationTag?: string;
  inlineTag?: string;
  domTarget?: string;
  external?: boolean;
};

type OpenNoteOptions = {
  equationTag?: string;
  inlineTag?: string;
  domTarget?: string;
  recordJump?: boolean;
};

type LinkPreviewOptions = {
  resolveTarget: (href: string) => LinkPreviewTarget;
  openNoteContent: (file: string) => Promise<Extract<Inbound, { type: "open" }>>;
  openNote: (note: NoteSummary, options?: OpenNoteOptions) => void;
  openExternalUrl: (href: string, options?: { newWindow?: boolean }) => void;
  isSafeHref: (href: string) => boolean;
  noteTitle: (note: NoteSummary) => string;
  resolveAssetUrl: (src: string, file: string) => string;
  beforeShow?: () => void;
  setStatus?: (message: string) => void;
};

export type LinkPreviewController = {
  element: HTMLElement;
  show: (href: string, x: number, y: number) => void;
  hide: () => void;
  dismissTransient: () => void;
  isOpen: () => boolean;
};

export function createLinkPreviewController(options: LinkPreviewOptions): LinkPreviewController {
  const element = document.createElement("div");
  element.className = "aaronnote-link-preview";
  element.hidden = true;
  document.body.appendChild(element);

  const showEpoch = new Epoch();
  let moved = false;
  let persistent = false;
  let transientSince = 0;

  function setPersistent(value: boolean): void {
    persistent = value;
    transientSince = value ? 0 : Date.now();
    element.dataset.previewState = value ? "persistent" : "transient";
  }

  function hide(): void {
    element.hidden = true;
    moved = false;
    setPersistent(false);
  }

  function dismissTransient(): void {
    if (element.hidden || persistent) return;
    if (Date.now() - transientSince < 100) return;
    hide();
  }

  function place(x: number, y: number): void {
    const margin = 10;
    const width = Math.min(760, Math.max(420, window.innerWidth * 0.54), window.innerWidth - margin * 2);
    element.style.width = `${width}px`;
    const rect = element.getBoundingClientRect();
    let left = x + 12;
    let top = y + 12;
    if (left + width > window.innerWidth - margin) left = Math.max(margin, x - width - 12);
    if (top + rect.height > window.innerHeight - margin) top = Math.max(margin, y - rect.height - 12);
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  }

  function makeDraggable(handle: HTMLElement): void {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const target = event.target as Element | null;
      if (target?.closest("button, a, input, textarea, select")) return;
      event.preventDefault();
      moved = true;
      const rect = element.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const startLeft = rect.left;
      const startTop = rect.top;
      const move = (moveEvent: PointerEvent) => {
        const margin = 8;
        const nextLeft = Math.min(Math.max(margin, startLeft + moveEvent.clientX - startX), Math.max(margin, window.innerWidth - element.offsetWidth - margin));
        const nextTop = Math.min(Math.max(margin, startTop + moveEvent.clientY - startY), Math.max(margin, window.innerHeight - element.offsetHeight - margin));
        element.style.left = `${nextLeft}px`;
        element.style.top = `${nextTop}px`;
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
    });
  }

  function renderChrome(title: string, subtitle: string, body: string, onOpen: () => void, renderOptions: { html?: boolean } = {}): void {
    element.replaceChildren();
    const head = document.createElement("header");
    head.className = "aaronnote-link-preview-head";
    const titleEl = document.createElement("strong");
    titleEl.textContent = title;
    const subtitleEl = document.createElement("span");
    subtitleEl.textContent = subtitle;
    head.append(titleEl, subtitleEl);
    makeDraggable(head);

    const content = document.createElement("div");
    content.className = renderOptions.html ? "aaronnote-link-preview-body aaronnote-link-preview-rendered" : "aaronnote-link-preview-body";
    if (renderOptions.html) content.innerHTML = body || "<p>No preview text</p>";
    else content.textContent = body || "No preview text";
    content.addEventListener("click", (event) => {
      const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || !content.contains(anchor)) return;
      event.preventDefault();
      options.openExternalUrl(anchor.getAttribute("href") || anchor.href, {
        newWindow: (event as MouseEvent).metaKey || (event as MouseEvent).altKey,
      });
    });

    const actions = document.createElement("div");
    actions.className = "aaronnote-link-preview-actions";
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.textContent = "Open";
    openButton.addEventListener("click", onOpen);
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "Close";
    closeButton.addEventListener("click", hide);
    actions.append(openButton, closeButton);
    element.append(head, content, actions);
  }

  function show(href: string, x: number, y: number): void {
    const target = options.resolveTarget(href);
    const run = showEpoch.begin();
    moved = false;
    setPersistent(false);
    options.beforeShow?.();
    element.hidden = false;
    renderChrome("Loading", href, "Loading preview...", () => options.openExternalUrl(href, { newWindow: false }));
    place(x, y);

    if (!target.note?.file) {
      const safe = options.isSafeHref(href);
      setPersistent(false);
      renderChrome(safe ? "External link" : "Blocked link", href, safe ? href : "Unsafe URL", () => {
        if (safe) options.openExternalUrl(href, { newWindow: true });
        else options.setStatus?.("Blocked unsafe link");
      });
      place(x, y);
      return;
    }

    const note = target.note;
    const title = options.noteTitle(note);
    const subtitle = note.path || note.file || href;
    void options.openNoteContent(note.file)
      .then((msg) => {
        if (!run.current) return;
        const html = renderMarkdownHTML(msg.content ?? "", {
          assetResolver: (src) => options.resolveAssetUrl(src, note.file || ""),
        });
        setPersistent(true);
        renderChrome(title, subtitle, html, () => {
          options.openNote(note, {
            equationTag: target.equationTag,
            inlineTag: target.inlineTag,
            domTarget: target.domTarget,
            recordJump: true,
          });
          hide();
        }, { html: true });
        if (!moved) place(x, y);
      })
      .catch((err) => {
        if (!run.current) return;
        setPersistent(false);
        renderChrome(title, subtitle, err instanceof Error ? err.message : "Preview failed", () => {
          options.openNote(note, {
            equationTag: target.equationTag,
            inlineTag: target.inlineTag,
            domTarget: target.domTarget,
            recordJump: true,
          });
          hide();
        });
        place(x, y);
      });
  }

  element.addEventListener("mousedown", (event) => event.stopPropagation());

  return {
    element,
    show,
    hide,
    dismissTransient,
    isOpen: () => !element.hidden,
  };
}
