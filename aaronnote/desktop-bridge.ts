/** Host-neutral packaged desktop smoke harness. */
if (new URL(location.href).searchParams.get("desktopSmoke") === "1") {
  let noteOpened = false;
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
    const knowledgeDock = document.querySelector<HTMLElement>(".noema-knowledge-dock");
    let tocPopover: HTMLElement | null = null;
    let tocVisible = false;
    let tocStatus = "";
    let tocItems: string[] = [];
    let dockOpenedByDoubleClick = false;
    let tagStatus = "";
    let tagItems: string[] = [];
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
        backlinksStatus: knowledgeDock.querySelector<HTMLElement>("[data-knowledge-backlink-status]")
          ?.textContent?.trim() || "",
        top: dockBounds?.top || 0,
        bottom: dockBounds?.bottom || 0,
        width: dockBounds?.width || 0,
        editorClearsDock: Boolean(editorBounds && dockBounds && editorBounds.right <= dockBounds.left + 1),
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
      } : null,
      katexMacros,
      kernel: backendKernel,
    };
    void window.noemaDesktop?.reportSmoke?.(report);
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
      if (!fallbackTimer) fallbackTimer = window.setTimeout(() => void reportSmoke(), 5_000);
      return;
    }
    window.setTimeout(() => void reportSmoke(), 250);
  };
  window.addEventListener("aaronnote:note-opened", () => {
    noteOpened = true;
    window.clearTimeout(fallbackTimer);
    fallbackTimer = 0;
    maybeReportSmoke();
  }, { once: true });
  if (document.readyState === "complete") maybeReportSmoke();
  else window.addEventListener("load", maybeReportSmoke, { once: true });
}

