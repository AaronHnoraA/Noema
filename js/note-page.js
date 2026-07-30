(function () {
  if (document.body && !document.body.classList.contains("hidden-note-page")) {
    document.body.classList.add("note-page");
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizePath(value) {
    return String(value || "")
      .replace(/^https?:\/\/[^/]+/i, "")
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/^\/+/, "")
      .replace(/\/+/g, "/");
  }

  function copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      return navigator.clipboard.writeText(text);
    }

    return Promise.reject(new Error("Clipboard API unavailable"));
  }

  document.addEventListener("DOMContentLoaded", () => {
    const content = document.getElementById("content");
    if (!content) {
      return;
    }

    const knowledge = window.KNOWLEDGE_DATA || null;
    const currentLink = normalizePath(window.CURRENT_NOTE_LINK || window.location.pathname);
    const siteRoot = String(window.SITE_ROOT_PATH || "./");
    const hiddenPage =
      document.body?.classList.contains("hidden-note-page") ||
      document.body?.classList.contains("note-page-hidden") ||
      false;
    if (hiddenPage) {
      return;
    }
    const currentNote = knowledge
      ? knowledge.notes.find((note) => normalizePath(note.link) === currentLink)
      : null;

    const titleEl = content.querySelector(".title");
    const toc = document.getElementById("table-of-contents");
    const headings = Array.from(content.querySelectorAll("h2[id], h3[id], h4[id], h5[id]"));
    const outlineText = Array.from(content.querySelectorAll("[class^='outline-text-']"))
      .map((node) => node.textContent.trim())
      .join(" ");
    const readableText = outlineText || content.textContent || "";
    const latinWordCount = (readableText.match(/[A-Za-z0-9_]+/g) || []).length;
    const cjkCount = (readableText.match(/[\u3400-\u9FFF]/g) || []).length;
    const readingUnits = latinWordCount + cjkCount;
    const readingMinutes = Math.max(1, Math.ceil(readingUnits / 260));
    const randomPool = knowledge?.publicNotes || knowledge?.notes || [];
    const randomNote = randomPool.length
      ? randomPool[Math.floor(Math.random() * randomPool.length)]
      : null;
    let previousNote = null;
    let nextNote = null;

    if (document.body) {
      document.body.dataset.noteTitle = (titleEl?.textContent || currentNote?.title || "Working Note").trim();
      document.body.dataset.noteGroup = String(currentNote?.groupLabel || "Note");
      document.body.dataset.noteDate = String(currentNote?.date || "Undated");
    }

    content.dataset.noteTitle = (titleEl?.textContent || currentNote?.title || "Working Note").trim();
    content.dataset.noteGroup = String(currentNote?.groupLabel || "Note");

    const progressBar = document.createElement("div");
    progressBar.className = "note-reading-progress";
    progressBar.innerHTML = '<span class="note-reading-progress-bar"></span>';
    document.body.appendChild(progressBar);
    const progressBarFill = progressBar.querySelector(".note-reading-progress-bar");

    const marginRail = document.createElement("aside");
    marginRail.className = "note-margin-rail";
    marginRail.setAttribute("aria-label", "Note margin");
    marginRail.innerHTML = `
      <div class="note-margin-card">
        <span class="note-margin-label">Collection</span>
        <strong>${escapeHtml(currentNote?.groupLabel || "Note")}</strong>
      </div>
      <div class="note-margin-card">
        <span class="note-margin-label">Date</span>
        <strong>${escapeHtml(currentNote?.date || "Undated")}</strong>
      </div>
      <div class="note-margin-card">
        <span class="note-margin-label">Reading</span>
        <strong>${readingMinutes} min</strong>
      </div>
      <div class="note-margin-card">
        <span class="note-margin-label">Section</span>
        <strong data-running-section>Opening</strong>
      </div>
    `;
    content.insertAdjacentElement("beforebegin", marginRail);

    function getScrollBehavior() {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    }

    function scrollToTarget(target, offset = 20) {
      const top = Math.max(0, window.scrollY + target.getBoundingClientRect().top - offset);
      window.scrollTo({ top, behavior: getScrollBehavior() });
    }

    function updateProgress() {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      const ratio = scrollable > 0 ? Math.min(1, Math.max(0, window.scrollY / scrollable)) : 0;
      progressBarFill.style.transform = `scaleX(${ratio})`;
      const progressText = document.querySelector("[data-reading-progress]");
      if (progressText) {
        progressText.textContent = `${Math.round(ratio * 100)}%`;
      }
    }

    function updateRunningSection() {
      if (headings.length === 0) {
        return;
      }

      let activeHeading = headings[0];
      headings.forEach((heading) => {
        if (heading.getBoundingClientRect().top <= 150) {
          activeHeading = heading;
        }
      });

      const label = (activeHeading?.textContent || "").trim().replace(/\s*#\s*$/, "");
      if (document.body) {
        document.body.dataset.currentSection = label || "Opening";
      }

      const runningSection = document.querySelector("[data-running-section]");
      if (runningSection) {
        runningSection.textContent = label || "Opening";
      }
    }

    function buildTocTree(items) {
      const roots = [];
      const stack = [];

      items.forEach((heading) => {
        const node = {
          id: heading.id,
          label: heading.textContent.trim().replace(/\s*#\s*$/, ""),
          level: Number(heading.tagName.slice(1)),
          children: [],
        };

        while (stack.length > 0 && stack[stack.length - 1].level >= node.level) {
          stack.pop();
        }

        if (stack.length > 0) {
          stack[stack.length - 1].children.push(node);
        } else {
          roots.push(node);
        }

        stack.push(node);
      });

      return roots;
    }

    function renderTocItems(nodes) {
      return `
        <ul class="note-floating-toc-tree">
          ${nodes
            .map((node) => {
              const hasChildren = node.children.length > 0;
              return `
                <li class="note-floating-toc-item" data-node-id="${escapeHtml(node.id)}" data-level="${node.level}">
                  <div class="note-floating-toc-row">
                    ${
                      hasChildren
                        ? `<button type="button" class="note-floating-toc-branch" data-toc-branch aria-expanded="true" aria-label="Toggle section">
                             <span class="note-floating-toc-branch-icon">▾</span>
                           </button>`
                        : '<span class="note-floating-toc-spacer"></span>'
                    }
                    <a class="note-floating-toc-link" data-target-id="${escapeHtml(node.id)}" href="#${escapeHtml(node.id)}">
                      ${escapeHtml(node.label)}
                    </a>
                  </div>
                  ${hasChildren ? renderTocItems(node.children) : ""}
                </li>
              `;
            })
            .join("")}
        </ul>
      `;
    }

    const toolbar = document.createElement("section");
    toolbar.className = "note-toolbar";
    toolbar.setAttribute("aria-label", "Note tools");
    toolbar.innerHTML = `
      <div class="note-toolbar-main">
        <a class="note-tool-link" href="${escapeHtml(`${siteRoot}index.html#notes-section`)}">All Notes</a>
        <button type="button" class="note-tool-btn" data-note-action="copy-page">Copy Link</button>
        <button type="button" class="note-tool-btn" data-note-action="random-note">Random Note</button>
        <button type="button" class="note-tool-btn" data-note-action="relations" aria-pressed="false">Relations</button>
        <button type="button" class="note-tool-btn" data-note-action="top">Top</button>
      </div>
      <div class="note-toolbar-side">
        <span class="note-progress-badge">${readingMinutes} min read</span>
        <span class="note-progress-badge" data-reading-progress>0%</span>
      </div>
    `;

    const header = content.querySelector("header") || titleEl?.parentElement || content.firstElementChild;
    const noteHeader = document.createElement("section");
    noteHeader.className = "note-header-panel";
    noteHeader.innerHTML = `
      <div class="note-header-meta">
        <span>${escapeHtml(currentNote?.groupLabel || "Note")}</span>
        <span>${escapeHtml(currentNote?.date || "Undated")}</span>
        <span>${readingMinutes} min read</span>
      </div>
      <p class="note-header-summary">${escapeHtml(currentNote?.summary || "Part of the published note archive.")}</p>
    `;
    if (header) {
      header.insertAdjacentElement("afterend", noteHeader);
      header.insertAdjacentElement("afterend", toolbar);
    } else {
      content.prepend(noteHeader);
      content.prepend(toolbar);
    }

    const relationButton = toolbar.querySelector('[data-note-action="relations"]');
    let noteGraphWindow = null;
    let noteGraphInstance = null;
    let noteGraphVisibleKeys = [];

    function buildNoteGraphVisibleKeys() {
      if (!knowledge || !currentNote) {
        return [];
      }

      const keys = new Set([currentNote.key, ...(currentNote.refs || []), ...(currentNote.backlinks || [])]);

      if (keys.size <= 1 && Array.isArray(currentNote.tags) && currentNote.tags.length > 0) {
        knowledge.notes
          .filter((note) => note.key !== currentNote.key && note.tags.some((tag) => currentNote.tags.includes(tag)))
          .slice(0, 6)
          .forEach((note) => keys.add(note.key));
      }

      return Array.from(keys);
    }

    function setNoteGraphOpen(isOpen) {
      if (!noteGraphWindow || !relationButton) {
        return;
      }

      noteGraphWindow.classList.toggle("is-open", isOpen);
      noteGraphWindow.setAttribute("aria-hidden", isOpen ? "false" : "true");
      relationButton.setAttribute("aria-pressed", isOpen ? "true" : "false");
    }

    function ensureNoteGraph() {
      if (!noteGraphWindow || noteGraphInstance) {
        return;
      }

      const graphContainer = noteGraphWindow.querySelector("[data-note-graph-container]");
      const graphFocus = noteGraphWindow.querySelector("[data-note-graph-focus]");

      if (typeof window.initKnowledgeGraph === "function" && typeof d3 !== "undefined") {
        noteGraphInstance = window.initKnowledgeGraph({
          container: graphContainer,
          focusPanel: graphFocus,
          linkPrefix: siteRoot,
          initialVisibleKeys: noteGraphVisibleKeys,
          initialSelectedId: currentNote?.key || "",
          toolbar: true,
          listenForGlobalFilters: false,
          dispatchTagEvents: false,
          dispatchFocusEvents: false,
          emptyMessage: "Select a node to inspect linked notes.",
        });
      } else if (graphContainer) {
        graphContainer.innerHTML = '<div class="graph-message">Graph view is unavailable right now.</div>';
      }
    }

    function toggleNoteGraph(forceOpen) {
      if (!noteGraphWindow) {
        return;
      }

      const nextOpen = typeof forceOpen === "boolean"
        ? forceOpen
        : !noteGraphWindow.classList.contains("is-open");

      if (nextOpen) {
        ensureNoteGraph();
      }

      setNoteGraphOpen(nextOpen);
    }

    if (knowledge && currentNote) {
      noteGraphVisibleKeys = buildNoteGraphVisibleKeys();
      noteGraphWindow = document.createElement("aside");
      noteGraphWindow.className = "note-graph-window";
      noteGraphWindow.setAttribute("aria-label", "Note relationships");
      noteGraphWindow.setAttribute("aria-hidden", "true");
      noteGraphWindow.innerHTML = `
        <div class="note-graph-window-header">
          <div>
            <span class="note-graph-window-kicker">Relations</span>
            <strong>Related Notes</strong>
          </div>
          <button type="button" class="note-graph-window-close" data-note-graph-close aria-label="Close relationships window">Close</button>
        </div>
        <div class="note-graph-window-body">
          <div class="note-graph-container" data-note-graph-container data-graph-toolbar="true"></div>
          <div class="graph-focus empty" data-note-graph-focus aria-live="polite">
            <p class="graph-focus-copy">Select a node to inspect linked notes.</p>
          </div>
        </div>
      `;
      document.body.appendChild(noteGraphWindow);

      noteGraphWindow.addEventListener("click", (event) => {
        if (event.target.closest("[data-note-graph-close]")) {
          toggleNoteGraph(false);
        }
      });
    } else if (relationButton) {
      relationButton.disabled = true;
      relationButton.textContent = "Relations NA";
    }

    toolbar.addEventListener("click", (event) => {
      const action = event.target.closest("[data-note-action]")?.dataset.noteAction;
      if (!action) {
        return;
      }

      if (action === "copy-page") {
        copyText(window.location.href)
          .then(() => {
            const button = toolbar.querySelector('[data-note-action="copy-page"]');
            if (button) {
              const original = button.textContent;
              button.textContent = "Copied";
              window.setTimeout(() => {
                button.textContent = original;
              }, 1200);
            }
          })
          .catch(() => {});
        return;
      }

      if (action === "top") {
        window.scrollTo({ top: 0, behavior: getScrollBehavior() });
        return;
      }

      if (action === "random-note" && randomNote) {
        window.location.href = `${siteRoot}${randomNote.link}`;
        return;
      }

      if (action === "relations") {
        toggleNoteGraph();
      }
    });

    if (headings.length > 0) {
      const storedTocState = window.localStorage.getItem("note-toc-collapsed");
      const shouldStartCollapsed = storedTocState === null
        ? window.innerWidth < 1480
        : storedTocState === "true";
      const tocTree = buildTocTree(headings);
      const floatingToc = document.createElement("aside");
      floatingToc.className = "note-floating-toc";
      floatingToc.setAttribute("aria-label", "Floating table of contents");
      floatingToc.innerHTML = `
        <div class="note-floating-toc-header">
          <span class="note-floating-toc-title">Contents</span>
          <button type="button" class="note-floating-toc-toggle" aria-expanded="${shouldStartCollapsed ? "false" : "true"}">
            ${shouldStartCollapsed ? "TOC" : "Hide"}
          </button>
        </div>
        <nav class="note-floating-toc-list">
          ${renderTocItems(tocTree)}
        </nav>
      `;

      content.insertAdjacentElement("beforebegin", floatingToc);

      const tocLinks = Array.from(floatingToc.querySelectorAll(".note-floating-toc-link"));
      const tocItems = Array.from(floatingToc.querySelectorAll(".note-floating-toc-item"));
      const tocToggle = floatingToc.querySelector(".note-floating-toc-toggle");

      function applyTocCollapsed(collapsed) {
        floatingToc.classList.toggle("is-collapsed", collapsed);
        if (tocToggle) {
          tocToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
          tocToggle.textContent = collapsed ? "TOC" : "Hide";
        }
        window.localStorage.setItem("note-toc-collapsed", String(collapsed));
      }

      function setBranchExpanded(item, expanded) {
        item.classList.toggle("is-closed", !expanded);
        const branchButton = item.querySelector(":scope > .note-floating-toc-row [data-toc-branch]");
        if (branchButton) {
          branchButton.setAttribute("aria-expanded", expanded ? "true" : "false");
        }
      }

      function expandAncestors(targetId) {
        let item = floatingToc.querySelector(`.note-floating-toc-item[data-node-id="${CSS.escape(targetId)}"]`);
        while (item) {
          setBranchExpanded(item, true);
          item = item.parentElement?.closest(".note-floating-toc-item");
        }
      }

      function updateActiveHeading() {
        let activeId = headings[0]?.id || "";

        headings.forEach((heading) => {
          if (heading.getBoundingClientRect().top <= 140) {
            activeId = heading.id;
          }
        });

        tocLinks.forEach((link) => {
          const isActive = link.dataset.targetId === activeId;
          link.classList.toggle("active", isActive);
        });

        if (activeId) {
          expandAncestors(activeId);
        }
      }

      applyTocCollapsed(shouldStartCollapsed);

      tocToggle?.addEventListener("click", () => {
        applyTocCollapsed(!floatingToc.classList.contains("is-collapsed"));
      });

      floatingToc.addEventListener("click", (event) => {
        const branch = event.target.closest("[data-toc-branch]");
        if (branch) {
          const item = branch.closest(".note-floating-toc-item");
          if (item) {
            setBranchExpanded(item, item.classList.contains("is-closed"));
          }
          return;
        }

        const link = event.target.closest(".note-floating-toc-link");
        if (!link) {
          return;
        }

        const target = document.getElementById(link.dataset.targetId || "");
        if (!target) {
          return;
        }

        event.preventDefault();
        scrollToTarget(target);
        window.history.replaceState(null, "", `#${target.id}`);
        updateActiveHeading();
      });

      tocItems.forEach((item) => {
        const level = Number(item.dataset.level || "2");
        if (level >= 4) {
          setBranchExpanded(item, false);
        }
      });
      updateActiveHeading();
      window.addEventListener("scroll", updateActiveHeading, { passive: true });
      window.addEventListener("resize", updateActiveHeading);
    }

    if (toc) {
      toc.classList.add("note-inline-toc");
      toc.addEventListener("click", (event) => {
        const link = event.target.closest('a[href^="#"]');
        if (!link) {
          return;
        }

        const targetId = decodeURIComponent(link.getAttribute("href").slice(1));
        const target = document.getElementById(targetId);
        if (!target) {
          return;
        }

        event.preventDefault();
        scrollToTarget(target);
        window.history.replaceState(null, "", `#${target.id}`);
      });
    }

    function renderNoteList(keys, emptyText) {
      if (!knowledge || !Array.isArray(keys) || keys.length === 0) {
        return `<p class="note-panel-empty">${escapeHtml(emptyText)}</p>`;
      }

      return `
        <div class="note-link-list">
          ${keys
            .map((key) => knowledge.byKey.get(key))
            .filter(Boolean)
            .map(
              (note) => `
                <a class="note-link-card" href="${escapeHtml(`${siteRoot}${note.link}`)}">
                  <strong>${escapeHtml(note.title)}</strong>
                  <span>${escapeHtml(note.groupLabel || note.section || "Note")}</span>
                </a>
              `,
            )
            .join("")}
        </div>
      `;
    }

    function renderTagLinks(tags) {
      if (!Array.isArray(tags) || tags.length === 0) {
        return '<p class="note-panel-empty">No tags for this note yet.</p>';
      }

      return `
        <div class="note-chip-row">
          ${tags
            .map(
              (tag) => `
                <a class="note-chip" href="${escapeHtml(`${siteRoot}index.html?tags=${encodeURIComponent(tag)}#notes-section`)}">
                  #${escapeHtml(tag)}
                </a>
              `,
            )
            .join("")}
        </div>
      `;
    }

    const context = document.createElement("section");
    context.className = "note-context-grid";
    const summaryText = currentNote?.summary || "This page is part of your published note collection.";
    const metaChips = [
      currentNote?.groupLabel || "Note",
      currentNote?.date || "Undated",
      `${readingMinutes} min read`,
      `${headings.length} headings`,
    ];

    context.innerHTML = `
      <article class="note-panel note-panel-summary">
        <span class="note-panel-label">Summary</span>
        <p class="note-panel-copy">${escapeHtml(summaryText)}</p>
        <div class="note-chip-row">
          ${metaChips.map((item) => `<span class="note-chip note-chip-static">${escapeHtml(item)}</span>`).join("")}
        </div>
      </article>
      <article class="note-panel">
        <span class="note-panel-label">Tags</span>
        ${renderTagLinks(currentNote?.tags || [])}
      </article>
      <article class="note-panel">
        <span class="note-panel-label">References</span>
        ${renderNoteList(currentNote?.refs || [], "No outgoing note references yet.")}
      </article>
      <article class="note-panel">
        <span class="note-panel-label">Backlinks</span>
        ${renderNoteList(currentNote?.backlinks || [], "No backlinks yet.")}
      </article>
    `;

    if (toc) {
      toc.insertAdjacentElement("afterend", context);
    } else if (toolbar) {
      toolbar.insertAdjacentElement("afterend", context);
    } else {
      content.prepend(context);
    }

    if (knowledge && currentNote) {
      const currentGroup = knowledge.groups.find((group) => group.key === currentNote.groupKey);
      const groupItems = currentGroup?.items || [];
      const currentIndex = groupItems.findIndex((note) => note.key === currentNote.key);
      previousNote = currentIndex > 0 ? groupItems[currentIndex - 1] : null;
      nextNote = currentIndex >= 0 && currentIndex < groupItems.length - 1 ? groupItems[currentIndex + 1] : null;

      if (previousNote || nextNote) {
        const sequence = document.createElement("section");
        sequence.className = "note-sequence-nav";
        sequence.innerHTML = `
          <a class="note-sequence-link ${previousNote ? "" : "is-disabled"}" ${previousNote ? `href="${escapeHtml(`${siteRoot}${previousNote.link}`)}"` : ""}>
            <span class="note-sequence-label">Previous</span>
            <strong>${escapeHtml(previousNote ? previousNote.title : "Start of section")}</strong>
          </a>
          <a class="note-sequence-link ${nextNote ? "" : "is-disabled"}" ${nextNote ? `href="${escapeHtml(`${siteRoot}${nextNote.link}`)}"` : ""}>
            <span class="note-sequence-label">Next</span>
            <strong>${escapeHtml(nextNote ? nextNote.title : "End of section")}</strong>
          </a>
        `;
        context.insertAdjacentElement("afterend", sequence);
      }
    }

    document.addEventListener("keydown", (event) => {
      const tagName = event.target?.tagName || "";
      const isTypingTarget = ["INPUT", "TEXTAREA", "SELECT"].includes(tagName) || event.target?.isContentEditable;
      if (isTypingTarget) {
        return;
      }

      if (event.key === "[" && previousNote) {
        window.location.href = `${siteRoot}${previousNote.link}`;
      } else if (event.key === "]" && nextNote) {
        window.location.href = `${siteRoot}${nextNote.link}`;
      } else if (event.key.toLowerCase() === "t") {
        document.querySelector(".note-floating-toc-toggle")?.click();
      } else if (event.key.toLowerCase() === "r" && noteGraphWindow) {
        toggleNoteGraph();
      } else if (event.key.toLowerCase() === "g") {
        window.scrollTo({ top: 0, behavior: getScrollBehavior() });
      } else if (event.key === "Escape" && noteGraphWindow?.classList.contains("is-open")) {
        toggleNoteGraph(false);
      }
    });

    headings.forEach((heading) => {
      const anchor = document.createElement("button");
      anchor.type = "button";
      anchor.className = "heading-anchor";
      anchor.setAttribute("aria-label", `Copy link to ${heading.textContent.trim()}`);
      anchor.textContent = "#";
      anchor.addEventListener("click", () => {
        const nextUrl = new URL(window.location.href);
        nextUrl.hash = heading.id;
        copyText(nextUrl.toString())
          .then(() => {
            anchor.textContent = "Copied";
            window.setTimeout(() => {
              anchor.textContent = "#";
            }, 1200);
          })
          .catch(() => {});
      });
      heading.appendChild(anchor);
      heading.classList.add("has-heading-anchor");
    });

    updateProgress();
    updateRunningSection();
    window.addEventListener("scroll", updateProgress, { passive: true });
    window.addEventListener("resize", updateProgress);
    window.addEventListener("scroll", updateRunningSection, { passive: true });
    window.addEventListener("resize", updateRunningSection);
  });
})();
