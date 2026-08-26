import { auditB3ComponentSystem } from "../src/b3-component-system.ts";
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
        if (backendKernel?.state === "listening") break;
      } catch {
        // The final report retains the last state so startup failures remain
        // visible instead of turning into a separate smoke harness failure.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    const workspaceRoot = document.querySelector<HTMLElement>(".noema-desktop-workspace.noema-workspace-layout");
    const initialWorkspaceLeaves = workspaceRoot?.querySelectorAll(".noema-workspace-leaf").length || 0;
    window.dispatchEvent(new CustomEvent("aaronnote:command", {
      detail: { command: "workspace-split-right" },
    }));
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    const splitWorkspaceLeaves = workspaceRoot?.querySelectorAll(".noema-workspace-leaf").length || 0;
    const splitWorkspaceFrames = workspaceRoot?.querySelectorAll(".noema-workspace-editor-frame").length || 0;
    window.dispatchEvent(new CustomEvent("aaronnote:command", {
      detail: { command: "workspace-close-active" },
    }));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const restoredWorkspaceLeaves = workspaceRoot?.querySelectorAll(".noema-workspace-leaf").length || 0;
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
        .map((item) => item.textContent?.trim() || "");
      window.dispatchEvent(new CustomEvent("aaronnote:command", {
        detail: { command: "knowledge-backlinks" },
      }));
      await new Promise<void>((resolve) => setTimeout(resolve, 220));
    }
    window.dispatchEvent(new CustomEvent("aaronnote:command", {
      detail: { command: "toggle-agenda" },
    }));
    const agendaDeadline = Date.now() + 4_000;
    let agendaDock = document.querySelector<HTMLElement>(".aaronnote-agenda-full.is-desktop-dock");
    while ((!agendaDock || !agendaDock.dataset.agendaSource) && Date.now() < agendaDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      agendaDock = document.querySelector<HTMLElement>(".aaronnote-agenda-full.is-desktop-dock");
    }
    // Window restoration and the shell's CSS transitions can overlap. Poll
    // actual geometry so an occluded WKWebView reports the settled layout.
    const layoutDeadline = Date.now() + 4_000;
    while (agendaDock && Date.now() < layoutDeadline) {
      const currentEditor = document.querySelector<HTMLElement>(".aaronnote-focused-shell")?.getBoundingClientRect();
      const currentKnowledge = knowledgeDock?.getBoundingClientRect();
      const currentAgenda = agendaDock.getBoundingClientRect();
      const clearsKnowledge = !currentKnowledge || Boolean(currentEditor && currentEditor.right <= currentKnowledge.left + 1);
      const clearsAgenda = Boolean(currentEditor && currentEditor.bottom <= currentAgenda.top + 1);
      const docksClear = !currentKnowledge || currentAgenda.right <= currentKnowledge.left + 1;
      if (clearsKnowledge && clearsAgenda && docksClear) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    const titlebar = document.querySelector<HTMLElement>("[data-desktop-titlebar]");
    const controls = Array.from(document.querySelectorAll<HTMLElement>("[data-desktop-command], [data-desktop-menu]"));
    const bounds = titlebar?.getBoundingClientRect();
    const dockBounds = knowledgeDock?.getBoundingClientRect();
    const agendaBounds = agendaDock?.getBoundingClientRect();
    const editorBounds = document.querySelector<HTMLElement>(".aaronnote-focused-shell")?.getBoundingClientRect();
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
      agendaDock: Boolean(agendaDock?.classList.contains("b3-panel")),
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
      productionHandfeel: auditProductionHandfeel(document),
      workspaceLayout: workspaceRoot ? {
        version: workspaceRoot.dataset.workspaceLayoutVersion || "",
        initialLeaves: initialWorkspaceLeaves,
        splitLeaves: splitWorkspaceLeaves,
        lazyFrames: splitWorkspaceFrames,
        restoredLeaves: restoredWorkspaceLeaves,
        splitControls: workspaceRoot.querySelectorAll("[data-noema-workspace-split]").length,
        rails: Array.from(document.querySelectorAll<HTMLElement>("[data-noema-dock-rail]"))
          .map((rail) => rail.dataset.noemaDockRail || ""),
      } : null,
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
        editorClearsDock: Boolean(editorBounds && dockBounds && editorBounds.right <= dockBounds.left + 1),
        position: knowledgeDock.dataset.noemaDockPosition || "",
        pinned: knowledgeDock.dataset.noemaDockPinned || "",
      } : null,
      agendaDock: agendaDock ? {
        visible: !agendaDock.hidden && Boolean(agendaBounds?.height),
        surface: agendaDock.dataset.agendaSurface || "",
        source: agendaDock.dataset.agendaSource || "",
        views: Array.from(agendaDock.querySelectorAll<HTMLElement>(".aaronnote-agenda-full-tabs button"))
          .map((tab) => tab.textContent?.trim() || ""),
        stats: agendaDock.querySelector<HTMLElement>(".aaronnote-agenda-full-stats")?.textContent?.trim() || "",
        top: agendaBounds?.top || 0,
        bottom: agendaBounds?.bottom || 0,
        height: agendaBounds?.height || 0,
        editorClearsDock: Boolean(editorBounds && agendaBounds && editorBounds.bottom <= agendaBounds.top + 1),
        clearsKnowledgeDock: Boolean(!dockBounds || !agendaBounds || agendaBounds.right <= dockBounds.left + 1),
        position: agendaDock.dataset.noemaDockPosition || "",
        pinned: agendaDock.dataset.noemaDockPinned || "",
      } : null,
      katexMacros,
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
    void window.noemaDesktop?.reportSmoke?.(nativeReport);
    void fetch("/api/desktop-smoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
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
