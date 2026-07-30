import { EditorState } from "@codemirror/state";
import type { RevealApi } from "reveal.js";

import { highlightCode } from "../src/code-highlight.ts";
import { tocIndexExtension, tocIndexFromState } from "../src/cm6/toc-index.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";

export type Slide = {
  from: number;
  to: number;
  cursor: number;
  title: string;
  parentTitle: string;
  vertical: boolean;
};

export type SlideTheme = "dark" | "light";

export type SlideCoordinate = { h: number; v: number };

export const REVEAL_MARKER_RE = /^\s*@@slides\(reveal\)\s*\[\s*\]\s*\r?\n?/im;
export const VERTICAL_MARKER_RE = /^\s*@@slides\(vertical\)\s*\[\s*\]\s*\r?\n?/im;
const LEADING_SLIDE_HEADING_RE = /^\s{0,3}#{1,2}\s+.*?(?:\r?\n|$)/;
const SLIDES_THEME_STORAGE_KEY = "aaronnote.slides.theme";

export function slideRangesFromState(state: EditorState): Slide[] {
  let parentTitle = "";
  const headings = tocIndexFromState(state).headings
    .filter((heading) => heading.source === "markdown"
      && (heading.renderLevel === 1 || (heading.renderLevel === 2 && !heading.omit)))
    .map((heading) => {
      const vertical = heading.renderLevel === 2 && Boolean(parentTitle);
      if (heading.renderLevel === 1) parentTitle = heading.text || "Untitled slide";
      return {
        from: heading.markerFrom ?? heading.pos,
        cursor: heading.markerFrom ?? heading.pos,
        title: heading.text || "Untitled slide",
        parentTitle: vertical ? parentTitle : (heading.text || "Untitled slide"),
        vertical,
      };
    });
  return headings.map((heading, index) => ({
    ...heading,
    to: headings[index + 1]?.from ?? state.doc.length,
  }));
}

export function initialSlideTheme(): SlideTheme {
  try {
    return window.localStorage.getItem(SLIDES_THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function persistSlideTheme(theme: SlideTheme): void {
  try {
    window.localStorage.setItem(SLIDES_THEME_STORAGE_KEY, theme);
  } catch {
    // In-memory theme still works when WebKit storage is unavailable.
  }
}

/** Resolve Reveal's active page back to the source Markdown slide.
 *
 * The DOM marker is authoritative because authored Reveal sections and
 * vertical stacks are not always represented by a unique (h, v) pair.  The
 * coordinates remain as a compatibility fallback while Reveal initializes.
 */
export function sourceSlideIndexFromReveal(
  currentSlide: Element | null | undefined,
  coordinates: readonly SlideCoordinate[],
  indices: { h?: number; v?: number } = {},
): number {
  const marked = currentSlide?.closest<HTMLElement>("[data-aaronnote-slide-index]");
  const markedIndex = Number(marked?.dataset.aaronnoteSlideIndex);
  if (Number.isInteger(markedIndex) && markedIndex >= 0 && markedIndex < coordinates.length) {
    return markedIndex;
  }

  const h = Number.isFinite(indices.h) ? Number(indices.h) : 0;
  const v = Number.isFinite(indices.v) ? Number(indices.v) : 0;
  const exact = coordinates.findIndex((point) => point.h === h && point.v === v);
  if (exact >= 0) return exact;
  return coordinates.findIndex((point) => point.h === h);
}

function maskMarkdownMarker(markdown: string, marker: RegExp): string {
  return markdown.replace(marker, (match) => match.replace(/[^\r\n]/g, " "));
}

function codeLanguage(code: HTMLElement): string {
  for (const cls of code.classList) {
    if (cls.startsWith("language-")) return cls.slice("language-".length);
  }
  const source = code.textContent ?? "";
  if (/\b(?:function|const|let|return|interface|=>)\b/.test(source)) return "javascript";
  if (/\b(?:def|import|from|lambda|yield)\b/.test(source)) return "python";
  return "text";
}

export function setHighlightedCode(code: HTMLElement, source: string, language: string): void {
  const ranges = highlightCode(language, source);
  const fragment = document.createDocumentFragment();
  let position = 0;
  for (const range of ranges) {
    if (range.from > position) fragment.append(document.createTextNode(source.slice(position, range.from)));
    const span = document.createElement("span");
    span.className = range.className;
    span.textContent = source.slice(range.from, range.to);
    fragment.append(span);
    position = range.to;
  }
  if (position < source.length) fragment.append(document.createTextNode(source.slice(position)));
  code.replaceChildren(fragment);
}

function highlightSlideCode(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>("pre > code").forEach((code) => {
    if (code.closest(".aaronnote-slide-jupyter-cell")) return;
    const language = codeLanguage(code);
    code.classList.add(`language-${language}`);
    setHighlightedCode(code, code.textContent ?? "", language);
  });
}

/** Pure slide DOM renderer. It has no Editor, Jupyter, mirror, or API access. */
export function createRevealSlide(
  markdown: string,
  index: number,
  options: { jupyterCells?: boolean } = {},
): HTMLElement {
  const section = document.createElement("section");
  section.dataset.aaronnoteSlideIndex = String(index);
  const marker = REVEAL_MARKER_RE.exec(markdown);
  if (!marker) {
    const rendered = document.createElement("div");
    rendered.className = "cm-editor aaronnote-rendered-slide";
    const body = maskMarkdownMarker(markdown, VERTICAL_MARKER_RE);
    rendered.innerHTML = renderMarkdownHTML(body, {
      allowHtml: true,
      renderJupyterCells: options.jupyterCells === true,
    });
    highlightSlideCode(rendered);
    section.appendChild(rendered);
    return section;
  }

  section.classList.add("aaronnote-raw-reveal-slide");
  const headingSource = LEADING_SLIDE_HEADING_RE.exec(markdown)?.[0] ?? "";
  const raw = markdown.replace(REVEAL_MARKER_RE, "").replace(LEADING_SLIDE_HEADING_RE, "").trim();
  const holder = document.createElement("div");
  holder.innerHTML = raw;
  const authoredSection = holder.querySelector(":scope > section");
  if (authoredSection) {
    for (const attribute of authoredSection.attributes) {
      if (attribute.name.startsWith("data-aaronnote-")) continue;
      if (attribute.name === "class") {
        section.classList.add(...Array.from(authoredSection.classList));
      } else {
        section.setAttribute(attribute.name, attribute.value);
      }
    }
    section.innerHTML = authoredSection.innerHTML;
  } else {
    section.innerHTML = raw;
  }
  const headingLevel = /^\s{0,3}(#{1,2})\s/.exec(headingSource)?.[1]?.length ?? 0;
  if (headingSource && headingLevel > 0 && !section.querySelector(`:scope > h${headingLevel}`)) {
    const heading = document.createElement("div");
    heading.innerHTML = renderMarkdownHTML(headingSource, { allowHtml: true });
    const element = heading.firstElementChild;
    if (element) section.prepend(element);
  }
  // Authored HTML may contain arbitrary attributes, but slide identity is
  // owned by Noema and must survive Reveal stack navigation.
  section.dataset.aaronnoteSlideIndex = String(index);
  highlightSlideCode(section);
  return section;
}

export type SlidePresentationController = {
  update: (markdown: string) => void;
  rebuild: () => void;
  getReveal: () => RevealApi | null;
  getActiveIndex: () => number;
  destroy: () => void;
};

export type SlidePresentationBuildContext = {
  generation: number;
  markdown: string;
  state: EditorState;
  slides: readonly Slide[];
  isCurrent: () => boolean;
  addDisposer: (dispose: () => void) => void;
};

export type SlidePresentationSectionContext = SlidePresentationBuildContext & {
  index: number;
  slide: Slide;
  section: HTMLElement;
  source: string;
};

export type SlidePresentationReadyContext = SlidePresentationBuildContext & {
  reveal: RevealApi;
  revealRoot: HTMLElement;
};

/** One Reveal pipeline shared by slides notes and ordinary Markdown Slide
 * view. Optional hooks add interactive-only Jupyter/mirror behavior without
 * forking pagination, DOM construction, initialization, or lifecycle. */
export function createSlidePresentation(options: {
  root: HTMLElement;
  markdown: string;
  wholeDocumentFallback?: boolean;
  initialSlideIndex?: number;
  debounceMs?: number;
  renderSlide?: (context: Omit<SlidePresentationSectionContext, "section">) => HTMLElement;
  onBuildStart?: (context: SlidePresentationBuildContext) => void;
  onSectionMounted?: (context: SlidePresentationSectionContext) => void;
  onReady?: (context: SlidePresentationReadyContext) => void | (() => void) | Promise<void | (() => void)>;
  onActiveSlideChange?: (index: number) => void;
}): SlidePresentationController {
  let markdown = options.markdown;
  let reveal: RevealApi | null = null;
  let revealRoot: HTMLElement | null = null;
  let generation = 0;
  let destroyed = false;
  let renderTimer = 0;
  let slides: Slide[] = [];
  let active = Math.max(0, Math.floor(options.initialSlideIndex ?? 0));
  let buildDisposers: Array<() => void> = [];

  const clearBuild = (): void => {
    for (const dispose of buildDisposers.splice(0)) {
      try { dispose(); } catch {}
    }
    try { reveal?.destroy(); } catch {}
    reveal = null;
  };

  const build = async (buildGeneration: number): Promise<void> => {
    if (destroyed || buildGeneration !== generation) return;
    clearBuild();
    const nextRevealRoot = document.createElement("div");
    nextRevealRoot.className = "reveal";
    const nextRevealSlides = document.createElement("div");
    nextRevealSlides.className = "slides";
    nextRevealRoot.appendChild(nextRevealSlides);
    if (revealRoot?.isConnected) revealRoot.replaceWith(nextRevealRoot);
    else options.root.append(nextRevealRoot);
    revealRoot = nextRevealRoot;
    const state = EditorState.create({ doc: markdown, extensions: [tocIndexExtension] });
    slides = slideRangesFromState(state);
    if (options.wholeDocumentFallback && slides.length === 0 && state.doc.length > 0) {
      slides = [{
        from: 0,
        to: state.doc.length,
        cursor: 0,
        title: "Document",
        parentTitle: "Document",
        vertical: false,
      }];
    }
    active = slides.length === 0 ? -1 : Math.max(0, Math.min(active, slides.length - 1));
    const isCurrent = (): boolean => !destroyed && buildGeneration === generation;
    const addDisposer = (dispose: () => void): void => {
      if (!isCurrent()) {
        try { dispose(); } catch {}
        return;
      }
      buildDisposers.push(dispose);
    };
    const baseContext: SlidePresentationBuildContext = {
      generation: buildGeneration,
      markdown,
      state,
      slides,
      isCurrent,
      addDisposer,
    };
    options.onBuildStart?.(baseContext);
    const coordinates: SlideCoordinate[] = [];
    const mounted: SlidePresentationSectionContext[] = [];
    let horizontal = -1;
    let stack: HTMLElement | null = null;
    let lastHorizontal: HTMLElement | null = null;
    for (let index = 0; index < slides.length; index += 1) {
      const slide = slides[index]!;
      const source = state.doc.sliceString(slide.from, slide.to);
      const vertical = (slide.vertical || VERTICAL_MARKER_RE.test(source)) && lastHorizontal !== null;
      const renderContext = { ...baseContext, index, slide, source };
      const section = options.renderSlide?.(renderContext) ?? createRevealSlide(source, index);
      section.classList.toggle("aaronnote-vertical-slide", vertical);
      if (!vertical) {
        horizontal += 1;
        coordinates[index] = { h: horizontal, v: 0 };
        nextRevealSlides.append(section);
        lastHorizontal = section;
        stack = null;
      } else {
        if (!stack) {
          stack = document.createElement("section");
          nextRevealSlides.replaceChild(stack, lastHorizontal!);
          stack.append(lastHorizontal!);
        }
        coordinates[index] = { h: horizontal, v: stack.children.length };
        stack.append(section);
      }
      mounted.push({ ...renderContext, section });
    }
    if (slides.length === 0) nextRevealSlides.innerHTML = "<section><h2>No slides yet</h2></section>";
    for (const context of mounted) options.onSectionMounted?.(context);
    const [{ default: RevealRuntime }] = await Promise.all([
      import("reveal.js"),
      import("reveal.js/reveal.css"),
    ]);
    if (!isCurrent()) return;
    const instance = new RevealRuntime(nextRevealRoot, {
      controls: true, progress: false, slideNumber: "c/t", hash: false,
      keyboard: true, touch: true, center: false, transition: "slide",
      controlsLayout: "bottom-right", controlsTutorial: false,
      backgroundTransition: "fade",
      embedded: true,
      width: 1280, height: 720, margin: 0.04, minScale: 0.1, maxScale: 4,
    });
    // reveal.js resolves initialize() with its `ready` event at runtime even
    // though the declaration says RevealApi. Keep the constructed deck as the
    // API object; treating the resolved event as the deck makes slide()/sync()
    // throw after the content briefly flashes.
    try {
      await instance.initialize();
    } catch (error) {
      try { instance.destroy(); } catch {}
      throw error;
    }
    if (!isCurrent()) {
      instance.destroy();
      return;
    }
    reveal = instance;
    const updateActive = (event?: { currentSlide?: HTMLElement; indexh?: number; indexv?: number }): void => {
      if (!isCurrent()) return;
      const indices = reveal?.getIndices() as { h?: number; v?: number } | undefined;
      const next = sourceSlideIndexFromReveal(
        event?.currentSlide ?? reveal?.getCurrentSlide(),
        coordinates,
        {
          h: Number.isFinite(event?.indexh) ? event?.indexh : indices?.h,
          v: Number.isFinite(event?.indexv) ? event?.indexv : indices?.v,
        },
      );
      if (next < 0 || next === active) return;
      active = next;
      options.onActiveSlideChange?.(active);
    };
    reveal.on("slidechanged", (event) => updateActive(event as {
      currentSlide?: HTMLElement;
      indexh?: number;
      indexv?: number;
    }));
    const point = coordinates[Math.max(0, active)] ?? { h: 0, v: 0 };
    reveal.slide(point.h, point.v);
    updateActive();
    const disposeReady = await options.onReady?.({
      ...baseContext,
      reveal,
      revealRoot: nextRevealRoot,
    });
    if (typeof disposeReady === "function") addDisposer(disposeReady);
    if (!isCurrent() || reveal !== instance) return;
    reveal.sync();
    options.root.focus({ preventScroll: true });
  };

  const startBuild = (delay = options.debounceMs ?? 0): void => {
    window.clearTimeout(renderTimer);
    const buildGeneration = ++generation;
    const run = (): void => {
      void build(buildGeneration).catch((error) => {
        if (destroyed || buildGeneration !== generation) return;
        // Optional ready hooks and a late sync must not erase an otherwise
        // usable initialized deck.
        if (reveal) return;
        const slidesRoot = revealRoot?.querySelector<HTMLElement>(".slides");
        if (!slidesRoot) return;
        slidesRoot.innerHTML = "<section><h2>Slides unavailable</h2><p></p></section>";
        slidesRoot.querySelector("p")!.textContent = error instanceof Error ? error.message : "Reveal failed to initialize";
      });
    };
    if (delay > 0) renderTimer = window.setTimeout(run, delay);
    else run();
  };

  startBuild();
  return {
    update(nextMarkdown: string): void {
      if (destroyed || nextMarkdown === markdown) return;
      markdown = nextMarkdown;
      startBuild();
    },
    rebuild(): void {
      if (!destroyed) startBuild(0);
    },
    getReveal: () => reveal,
    getActiveIndex: () => active,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      generation += 1;
      window.clearTimeout(renderTimer);
      clearBuild();
      revealRoot?.remove();
      revealRoot = null;
    },
  };
}
