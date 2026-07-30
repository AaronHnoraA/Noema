import type { RevealApi } from "reveal.js";

import { jupyterCellsFromState, type JupyterCellDescriptor } from "../src/cm6/extensions/visual/widgets/block-extras.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";
import type { Editor } from "../src/lib.ts";
import type { JupyterWidgetKernelMessage } from "../src/jupyter-widget-runtime.ts";
import { api } from "./api-client.ts";
import {
  createRevealSlide,
  createSlidePresentation,
  initialSlideTheme,
  persistSlideTheme,
  setHighlightedCode,
  type SlidePresentationBuildContext,
  type SlidePresentationController,
  type SlidePresentationReadyContext,
  type SlidePresentationSectionContext,
  type SlideTheme,
} from "./slide-presentation.ts";

export { slideRangesFromState } from "./slide-presentation.ts";
export type { Slide, SlideTheme } from "./slide-presentation.ts";

export type SlideDeckController = {
  sync: (kind: string) => void;
  refresh: () => void;
  toggleView: () => void;
  toggleTheme: () => SlideTheme;
  getTheme: () => SlideTheme;
  isSlides: () => boolean;
  isRevealView: () => boolean;
  openMirror: () => Promise<void>;
  destroy: () => void;
};

function normalizedKind(kind: string): string {
  return String(kind || "").trim().toLowerCase();
}

function interactiveSlideTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(
    "a, button, input, textarea, select, [contenteditable='true'], iframe, video, audio, .controls",
  ));
}

export function createSlideDeckController(options: {
  root: HTMLElement;
  host: HTMLElement;
  editor: Editor;
  getCurrentFile: () => string;
}): SlideDeckController {
  const { editor } = options;
  const viewer = document.createElement("div");
  viewer.className = "aaronnote-reveal-view";
  viewer.hidden = true;
  viewer.tabIndex = -1;
  let theme = initialSlideTheme();
  viewer.dataset.theme = theme;
  options.root.dataset.slidesTheme = theme;
  options.root.appendChild(viewer);

  let enabled = false;
  let view: "reveal" | "edit" = "reveal";
  let presentation: SlidePresentationController | null = null;
  let presentationFile = "";
  let activeSlide = 0;
  let mirrorFile = "";
  let buildJupyterCells: JupyterCellDescriptor[] = [];

  const hydrateJupyterCell = async (
    cell: HTMLElement,
    descriptor: JupyterCellDescriptor,
    context: SlidePresentationSectionContext,
  ): Promise<void> => {
    const header = document.createElement("div");
    header.className = "cm-ceil-header";
    const label = document.createElement("span");
    label.className = "cm-ceil-label";
    label.textContent = "JUPYTER";
    const runtime = document.createElement("span");
    runtime.className = "cm-ceil-status";
    runtime.textContent = `${descriptor.language} · ${descriptor.session}`;
    header.append(label, runtime);
    const source = document.createElement("div");
    source.className = "cm-ceil-source cm-ceil-source-compact";
    source.textContent = "Loading source…";
    const output = document.createElement("div");
    output.className = "cm-ceil-output cm-ceil-output-limited";
    output.textContent = "Loading saved output…";
    cell.replaceChildren(header, source, output);
    try {
      const result = await api.jupyterCell.readScriptCell({
        file: options.getCurrentFile(),
        cellId: descriptor.cellId,
        kernel: descriptor.kernel,
        session: descriptor.session,
        language: descriptor.language,
      });
      if (!context.isCurrent() || !cell.isConnected || view !== "reveal") return;
      const codeText = String(result.code ?? "");
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.className = `language-${descriptor.language}`;
      setHighlightedCode(code, codeText, descriptor.language);
      pre.append(code);
      source.replaceChildren(pre);
      const saved = result.output && typeof result.output === "object"
        ? result.output as {
            outputs?: unknown[];
            executionCount?: number | null;
            status?: string;
            widgetRuntime?: { id: string; name: string; generation?: number };
            widgetMessages?: JupyterWidgetKernelMessage[];
            widgetOutputs?: Record<string, unknown[]>;
          }
        : null;
      const outputs = Array.isArray(saved?.outputs) ? saved.outputs : [];
      runtime.textContent = saved?.executionCount != null
        ? `${descriptor.language} · In [${saved.executionCount}]`
        : `${descriptor.language} · ${saved?.status || descriptor.session}`;
      if (/^lean4?$/i.test(descriptor.language)) {
        output.remove();
        presentation?.getReveal()?.layout();
        return;
      }
      if (outputs.length === 0) {
        const empty = document.createElement("div");
        empty.className = "cm-ceil-output-empty";
        empty.textContent = "No saved output";
        output.replaceChildren(empty);
      } else {
        const { renderJupyterOutputs } = await import("../src/jupyter-rendermime.ts");
        if (!context.isCurrent() || !cell.isConnected || view !== "reveal") return;
        output.replaceChildren();
        const dispose = renderJupyterOutputs(output, outputs, {
          markdownParser: { async render(markdown: string) { return renderMarkdownHTML(markdown); } },
          widgetRuntime: saved?.widgetRuntime,
          widgetMessages: saved?.widgetMessages,
          widgetOutputs: saved?.widgetOutputs,
          mountWidget: async (host, modelId, widgetRuntime, messages, widgetOutputs) => {
            (window as unknown as { __jupyter_widgets_assets_path__?: string }).__jupyter_widgets_assets_path__ ??=
              new URL("./", window.location.href).toString();
            const { mountJupyterWidget } = await import("../src/jupyter-widget-runtime.ts");
            return mountJupyterWidget(
              host,
              modelId,
              widgetRuntime,
              messages as JupyterWidgetKernelMessage[],
              widgetOutputs,
            );
          },
        });
        context.addDisposer(dispose);
      }
      presentation?.getReveal()?.layout();
    } catch (error) {
      if (!context.isCurrent() || !cell.isConnected) return;
      const failure = document.createElement("div");
      failure.className = "cm-ceil-output-error";
      failure.textContent = error instanceof Error ? error.message : "Jupyter cell unavailable";
      output.replaceChildren(failure);
    }
  };

  const loadRevealMirror = async (): Promise<{ js: string; css: string; jsFile: string } | null> => {
    const file = options.getCurrentFile();
    if (!file) return null;
    try {
      const mirror = await api.slides.mirror({ file });
      mirrorFile = mirror.jsFile;
      return mirror;
    } catch {
      mirrorFile = "";
      return null;
    }
  };

  const installRevealMirror = async (context: SlidePresentationReadyContext): Promise<() => void> => {
    const mirror = await loadRevealMirror();
    if (!mirror || !context.isCurrent() || view !== "reveal") return () => {};
    const style = document.createElement("style");
    style.dataset.aaronnoteRevealMirror = options.getCurrentFile();
    style.textContent = mirror.css;
    viewer.appendChild(style);
    let moduleDispose: (() => void) | null = null;
    try {
      if (mirror.js.trim()) {
        const url = URL.createObjectURL(new Blob([mirror.js], { type: "text/javascript" }));
        try {
          const module = await import(/* @vite-ignore */ url) as {
            default?: (context: { Reveal: RevealApi; root: HTMLElement; file: string }) => unknown;
          };
          if (context.isCurrent()) {
            const result = await module.default?.({
              Reveal: context.reveal,
              root: context.revealRoot,
              file: options.getCurrentFile(),
            });
            if (typeof result === "function") moduleDispose = result as () => void;
          }
        } finally {
          URL.revokeObjectURL(url);
        }
      }
    } catch {
      // A note-specific mirror is optional and must never blank the deck.
    }
    const dispose = (): void => {
      try { moduleDispose?.(); } catch {}
      style.remove();
    };
    if (!context.isCurrent()) {
      dispose();
      return () => {};
    }
    return dispose;
  };

  const createPresentation = (): void => {
    presentation?.destroy();
    presentationFile = options.getCurrentFile();
    presentation = createSlidePresentation({
      root: viewer,
      markdown: editor.getMarkdown(),
      initialSlideIndex: activeSlide,
      debounceMs: 140,
      renderSlide: ({ source, index }) => createRevealSlide(source, index, { jupyterCells: true }),
      onBuildStart: (_context: SlidePresentationBuildContext) => {
        buildJupyterCells = jupyterCellsFromState(editor.view.state, options.getCurrentFile());
      },
      onSectionMounted: (context) => {
        const cells = buildJupyterCells.filter((cell) => cell.from >= context.slide.from && cell.from < context.slide.to);
        context.section.querySelectorAll<HTMLElement>(".aaronnote-slide-jupyter-cell").forEach((cell, cellIndex) => {
          const descriptor = cells[cellIndex];
          if (descriptor) void hydrateJupyterCell(cell, descriptor, context);
        });
      },
      onReady: installRevealMirror,
      onActiveSlideChange: (index) => { activeSlide = index; },
    });
  };

  const destroyPresentation = (): void => {
    if (presentation) activeSlide = Math.max(0, presentation.getActiveIndex());
    presentation?.destroy();
    presentation = null;
    presentationFile = "";
    buildJupyterCells = [];
  };

  const applyView = (): void => {
    const revealView = enabled && view === "reveal";
    viewer.hidden = !revealView;
    options.host.hidden = revealView;
    options.root.classList.toggle("aaronnote-slides-reveal", revealView);
    options.root.classList.toggle("aaronnote-slides-edit", enabled && !revealView);
    if (revealView) createPresentation();
    else {
      destroyPresentation();
      if (enabled) editor.focus();
    }
  };

  const refresh = (): void => {
    if (!enabled || view !== "reveal") return;
    if (!presentation || presentationFile !== options.getCurrentFile()) {
      activeSlide = 0;
      createPresentation();
      return;
    }
    presentation.update(editor.getMarkdown());
  };

  viewer.addEventListener("pointerdown", (event) => {
    if (!interactiveSlideTarget(event.target)) viewer.focus({ preventScroll: true });
  });

  return {
    sync(kind: string): void {
      const nextEnabled = normalizedKind(kind) === "slides";
      if (enabled === nextEnabled) {
        refresh();
        return;
      }
      enabled = nextEnabled;
      options.root.classList.toggle("aaronnote-slides", enabled);
      if (!enabled) {
        destroyPresentation();
        viewer.hidden = true;
        options.host.hidden = false;
        options.root.classList.remove("aaronnote-slides-reveal", "aaronnote-slides-edit");
        return;
      }
      activeSlide = 0;
      view = "reveal";
      applyView();
    },
    refresh,
    toggleView(): void {
      if (!enabled) return;
      view = view === "reveal" ? "edit" : "reveal";
      applyView();
    },
    toggleTheme(): SlideTheme {
      theme = theme === "dark" ? "light" : "dark";
      viewer.dataset.theme = theme;
      options.root.dataset.slidesTheme = theme;
      persistSlideTheme(theme);
      return theme;
    },
    getTheme: () => theme,
    isSlides: () => enabled,
    isRevealView: () => enabled && view === "reveal",
    async openMirror(): Promise<void> {
      if (!enabled) return;
      await loadRevealMirror();
      if (mirrorFile) await api.emacs.open({ file: mirrorFile });
    },
    destroy(): void {
      destroyPresentation();
      viewer.remove();
      delete options.root.dataset.slidesTheme;
    },
  };
}
