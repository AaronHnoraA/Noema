import { auditB3ComponentSystem } from "../src/b3-component-system.ts";
import { optimalLinebreakAudit } from "../src/cm6/extensions/visual/optimal-linebreak.ts";
import { auditVisualTypography } from "../src/cm6/extensions/visual/typography.ts";
import { auditProductionHandfeel } from "../src/cm6/production-handfeel-audit.ts";

/** Host-neutral packaged desktop smoke harness. */
const desktopSmokeParams = new URL(location.href).searchParams;
if (desktopSmokeParams.get("desktopSmoke") === "1") {
  const protocolProbeExpected = desktopSmokeParams.get("desktopProtocolProbe")?.trim() || "";
  let noteOpened = false;
  let openedNoteFile = "";
  let reportStarted = false;
  let fallbackTimer = 0;
  const reportSmoke = async () => {
    if (reportStarted) return;
    reportStarted = true;
    window.clearTimeout(fallbackTimer);
    let backendKernel: Window["__noemaKernel"] = window.__noemaKernel;
    const kernelDeadline = Date.now() + 120_000;
    while (Date.now() < kernelDeadline) {
      try {
        const health = await fetch("/health", { cache: "no-store" }).then((response) => response.json());
        backendKernel = health?.kernel || backendKernel;
        if (backendKernel?.state === "listening" || backendKernel?.reason === "node-default") break;
      } catch {
        // The final report retains the last state so startup failures remain
        // visible instead of turning into a separate smoke harness failure.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    const editorHost = document.querySelector<HTMLElement>("[data-editor]");
    const focusedShell = document.querySelector<HTMLElement>(".aaronnote-focused-shell");
    // Run the editor probe before this harness opens TOC/Knowledge/Agenda.
    // Those smoke-only surfaces change the available viewport and can turn a
    // scroll measurement into a panel-layout benchmark.
    let editorPerformance: Record<string, number | boolean> | null = null;
    const runEditorPerf = (window as Window & {
      __noemaRunEditorPerfProbe?: () => Promise<Record<string, number | boolean>>;
    }).__noemaRunEditorPerfProbe;
    if (runEditorPerf) {
      try {
        editorPerformance = await runEditorPerf();
      } catch {
        // A null result makes the packaged performance regression visible in
        // the smoke report without hiding the rest of the adapter diagnostics.
      }
    }
    const knowledgeDock = document.querySelector<HTMLElement>(".noema-knowledge-dock");
    let tocPopover: HTMLElement | null = null;
    let tocVisible = false;
    let tocStatus = "";
    let tocItems: string[] = [];
    let dockOpenedByDoubleClick = false;
    let tagStatus = "";
    let tagItems: string[] = [];
    let mentionStatus = "";
    let mentionItems: string[] = [];
    if (knowledgeDock) {
      window.dispatchEvent(new CustomEvent("aaronnote:command", {
        detail: { command: "toggle-toc" },
      }));
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      tocPopover = document.querySelector<HTMLElement>(".aaronnote-floating-toc");
      tocVisible = Boolean(tocPopover && !tocPopover.classList.contains("is-collapsed"));
      tocStatus = tocPopover?.querySelector<HTMLElement>(".aaronnote-toc-status")?.textContent?.trim() || "";
      tocItems = Array.from(tocPopover?.querySelectorAll<HTMLElement>(".aaronnote-toc-item") ?? [])
        .slice(0, 100)
        .map((item) => item.textContent?.trim() || "");
      window.dispatchEvent(new CustomEvent("aaronnote:command", {
        detail: { command: "toggle-toc" },
      }));
      document.querySelector<HTMLElement>("[data-stats-toggle]")
        ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      dockOpenedByDoubleClick = !knowledgeDock.classList.contains("is-collapsed");
      window.dispatchEvent(new CustomEvent("aaronnote:command", {
        detail: { command: "knowledge-tags" },
      }));
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      tagStatus = knowledgeDock.querySelector<HTMLElement>("[data-knowledge-tag-status]")
        ?.textContent?.trim() || "";
      tagItems = Array.from(knowledgeDock.querySelectorAll<HTMLElement>(".noema-knowledge-tag > span"))
        .slice(0, 100)
        .map((item) => item.textContent?.trim() || "");
      window.dispatchEvent(new CustomEvent("aaronnote:command", {
        detail: { command: "knowledge-mentions" },
      }));
      const mentionDeadline = Date.now() + 4_000;
      do {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        mentionStatus = knowledgeDock.querySelector<HTMLElement>("[data-knowledge-mention-status]")
          ?.textContent?.trim() || "";
      } while ((!mentionStatus || mentionStatus.startsWith("Scanning")) && Date.now() < mentionDeadline);
      mentionItems = Array.from(knowledgeDock.querySelectorAll<HTMLElement>("[data-knowledge-mention-list] strong"))
        .slice(0, 100)
        .map((item) => item.textContent?.trim() || "");
      window.dispatchEvent(new CustomEvent("aaronnote:command", {
        detail: { command: "knowledge-backlinks" },
      }));
      await new Promise<void>((resolve) => setTimeout(resolve, 220));
    }
    window.dispatchEvent(new CustomEvent("aaronnote:command", { detail: { command: "toggle-agenda" } }));
    const agendaDeadline = Date.now() + 4_000;
    let agendaSurface = document.querySelector<HTMLElement>(".aaronnote-roam-tools.is-agenda");
    while ((!agendaSurface || agendaSurface.hidden) && Date.now() < agendaDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      agendaSurface = document.querySelector<HTMLElement>(".aaronnote-roam-tools.is-agenda");
    }
    const titlebar = document.querySelector<HTMLElement>("[data-desktop-titlebar]");
    const statusHud = document.querySelector<HTMLElement>(".aaronnote-status-hud");
    const bibliography = document.querySelector<HTMLElement>(".aaronnote-bib-panel");
    const controls = Array.from(document.querySelectorAll<HTMLElement>("[data-desktop-command], [data-desktop-menu]"));
    const bounds = titlebar?.getBoundingClientRect();
    const dockBounds = knowledgeDock?.getBoundingClientRect();
    const agendaBounds = agendaSurface?.getBoundingClientRect();
    const editorBounds = focusedShell?.getBoundingClientRect();
    const themeStyle = getComputedStyle(document.documentElement);
    const theme = {
      id: document.documentElement.dataset.noemaTheme || "",
      colorScheme: themeStyle.colorScheme,
      noemaBackground: themeStyle.getPropertyValue("--aaronnote-bg").trim(),
      noemaInk: themeStyle.getPropertyValue("--aaron-ink").trim(),
      b3ThemeBackground: themeStyle.getPropertyValue("--b3-theme-background").trim(),
      b3ThemePrimary: themeStyle.getPropertyValue("--b3-theme-primary").trim(),
      b3BorderColor: themeStyle.getPropertyValue("--b3-border-color").trim(),
    };
    const b3Audit = auditB3ComponentSystem(document.body);
    const b3Components = {
      ...b3Audit,
      knowledgeDock: Boolean(knowledgeDock?.classList.contains("b3-panel")),
      tocPopover: Boolean(tocPopover?.classList.contains("b3-panel")),
      agendaSurface: Boolean(agendaSurface?.classList.contains("b3-panel")),
    };
    let katexMacros: { source: string; count: number; errors: number } | null = null;
    try {
      const result = await window.aaronnoteApi?.config?.katexMacros();
      katexMacros = {
        source: String(result?.source || ""),
        count: Object.keys(result?.macros || {}).length,
        errors: Array.isArray(result?.errors) ? result.errors.length : 0,
      };
    } catch {
      // The report keeps a null value so a packaged transport regression is
      // visible without preventing the remaining host smoke assertions.
    }
    const report = {
      hostMode: document.body.dataset.hostMode || "",
      preload: Boolean(window.noemaDesktop),
      titlebarVisible: Boolean(titlebar && !titlebar.hidden && bounds && bounds.height > 0),
      titlebarHeight: bounds?.height || 0,
      controls: controls.map((control) => control.getAttribute("aria-label")),
      theme,
      b3Components,
      visualTypography: auditVisualTypography(document),
      lineBreaking: {
        optimalParagraphs: document.querySelectorAll(".cm-line.cm-kp-paragraph").length,
        visualBreaks: document.querySelectorAll(".cm-kp-break").length,
        generatedSpacers: document.querySelectorAll(".cm-kp-spacer").length,
        audit: optimalLinebreakAudit(),
      },
      productionHandfeel: auditProductionHandfeel(document),
      sharedEditor: {
        mountCount: document.querySelectorAll(".aaronnote-focused-editor[data-editor]").length,
        directShellChild: editorHost?.parentElement === focusedShell,
        iframeCount: document.querySelectorAll(".noema-workspace-editor-frame").length,
        workspaceWrapper: Boolean(document.querySelector(".noema-desktop-workspace, .noema-workspace-layout")),
        persistentDockRails: document.querySelectorAll("[data-noema-dock-rail]").length,
      },
      canvas: {
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        shellBackground: focusedShell ? getComputedStyle(focusedShell).backgroundColor : "",
        statusHudIsPanel: Boolean(statusHud?.classList.contains("b3-panel")),
        statusHudBackground: statusHud ? getComputedStyle(statusHud).backgroundColor : "",
        bibliographyIsPanel: Boolean(bibliography?.classList.contains("b3-panel")),
      },
      tocPopover: tocPopover ? {
        visible: tocVisible,
        status: tocStatus,
        items: tocItems,
      } : null,
      knowledgeDock: knowledgeDock ? {
        visible: !knowledgeDock.classList.contains("is-collapsed") && Boolean(dockBounds?.width),
        openedByDoubleClick: dockOpenedByDoubleClick,
        view: knowledgeDock.dataset.knowledgeView || "",
        tabs: Array.from(knowledgeDock.querySelectorAll<HTMLElement>("[data-knowledge-view]"))
          .map((tab) => tab.textContent?.trim() || ""),
        tagStatus,
        tagItems,
        mentionStatus,
        mentionItems,
        backlinksStatus: knowledgeDock.querySelector<HTMLElement>("[data-knowledge-backlink-status]")
          ?.textContent?.trim() || "",
        top: dockBounds?.top || 0,
        bottom: dockBounds?.bottom || 0,
        width: dockBounds?.width || 0,
        overlaysEditor: Boolean(editorBounds && dockBounds && dockBounds.left < editorBounds.right),
      } : null,
      agendaSurface: agendaSurface ? {
        visible: !agendaSurface.hidden && Boolean(agendaBounds?.height),
        presentation: "transient",
        top: agendaBounds?.top || 0,
        bottom: agendaBounds?.bottom || 0,
        height: agendaBounds?.height || 0,
      } : null,
      katexMacros,
      editorPerformance,
      kernel: backendKernel,
      protocolProbe: protocolProbeExpected ? {
        expected: protocolProbeExpected,
        openedFile: openedNoteFile,
        matched: noteOpened,
      } : null,
    };
    const nativeReport: Record<string, unknown> = { ...report };
    if (desktopSmokeParams.get("desktopPrintProbe") === "1") {
      try {
        nativeReport.printDocument = window.__noemaDesktopPrintDocument?.() || null;
      } catch {
        nativeReport.printDocument = null;
      }
    }
    // Persist the diagnostic before asking the native smoke adapter to quit.
    // The old fire-and-forget ordering let Electron tear down the renderer and
    // its Node host before this request left the page, producing a successful
    // smoke exit with no report — exactly when performance evidence mattered.
    try {
      await fetch("/api/desktop-smoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(report),
      });
    } catch {
      // The native IPC report still closes the smoke run and exposes failures
      // through its own adapter diagnostics when the host is unavailable.
    }
    await window.noemaDesktop?.reportSmoke?.(nativeReport);
  };
  const maybeReportSmoke = (): void => {
    if (reportStarted || document.readyState !== "complete") return;
    const editorRoute = Boolean(document.querySelector(".noema-knowledge-dock"));
    if (editorRoute && !noteOpened) {
      if (!fallbackTimer) fallbackTimer = window.setTimeout(
        () => void reportSmoke(),
        protocolProbeExpected ? 30_000 : 5_000,
      );
      return;
    }
    window.setTimeout(() => void reportSmoke(), 250);
  };
  const onNoteOpened = (event: Event): void => {
    const file = String((event as CustomEvent<{ file?: string }>).detail?.file || "").trim();
    openedNoteFile = file;
    if (protocolProbeExpected) {
      const normalizedFile = file.replace(/\\/g, "/");
      const normalizedExpected = protocolProbeExpected.replace(/\\/g, "/").replace(/^\.\//, "");
      if (normalizedFile !== normalizedExpected && !normalizedFile.endsWith(`/${normalizedExpected}`)) return;
    }
    noteOpened = true;
    window.removeEventListener("aaronnote:note-opened", onNoteOpened);
    window.clearTimeout(fallbackTimer);
    fallbackTimer = 0;
    maybeReportSmoke();
  };
  window.addEventListener("aaronnote:note-opened", onNoteOpened);
  if (document.readyState === "complete") maybeReportSmoke();
  else window.addEventListener("load", maybeReportSmoke, { once: true });
}
