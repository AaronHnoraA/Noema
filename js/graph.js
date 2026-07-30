(function () {
  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function resolveElement(target, fallbackId) {
    if (target && typeof target !== "string") {
      return target;
    }

    const id = typeof target === "string" && target ? target : fallbackId;
    return id ? document.getElementById(id) : null;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function linkEndpointId(endpoint) {
    return typeof endpoint === "string" ? endpoint : endpoint?.id;
  }

  function initKnowledgeGraph(options = {}) {
    const knowledge = options.knowledge || window.KNOWLEDGE_DATA;
    const container = resolveElement(options.container, options.containerId || "graph-container");
    const focusPanel = resolveElement(options.focusPanel, options.focusPanelId || "graph-focus");
    const linkPrefix = String(options.linkPrefix || "");
    const emptyMessage = String(options.emptyMessage || "Select a node to inspect its links.");
    const listenForGlobalFilters = options.listenForGlobalFilters !== false;
    const dispatchTagEvents = options.dispatchTagEvents !== false;
    const dispatchFocusEvents = options.dispatchFocusEvents !== false;
    const onNoteOpen = typeof options.onNoteOpen === "function" ? options.onNoteOpen : null;
    const wantToolbar = options.toolbar === true
      || (container && container.dataset && container.dataset.graphToolbar === "true");
    let tagsVisible = options.showTags !== false;

    if (!container) {
      return null;
    }

    if (container.dataset.graphMounted === "true") {
      return container._knowledgeGraph || null;
    }

    if (typeof d3 === "undefined") {
      container.innerHTML = '<div class="graph-message">D3 failed to load.</div>';
      return null;
    }

    if (!knowledge || knowledge.notes.length === 0) {
      container.innerHTML = '<div class="graph-message">No notes available yet.</div>';
      return null;
    }

    const noteNodes = knowledge.notes.map((note) => ({
      id: note.key,
      key: note.key,
      label: note.title,
      kind: "note",
      note,
    }));

    const tagNodes = knowledge.tags.map((tag) => ({
      id: `tag:${tag.name}`,
      label: tag.name,
      kind: "tag",
      tag,
    }));

    const nodes = [...noteNodes, ...tagNodes];
    const links = [];
    const linkKeys = new Set();
    const nodeById = new Map(nodes.map((node) => [node.id, node]));

    function pushLink(source, target, kind) {
      if (!nodeById.has(source) || !nodeById.has(target)) {
        return;
      }
      const key = `${source}::${target}::${kind}`;
      if (linkKeys.has(key)) {
        return;
      }
      linkKeys.add(key);
      links.push({ source, target, kind });
    }

    knowledge.notes.forEach((note) => {
      note.refs.forEach((targetKey) => {
        pushLink(note.key, targetKey, "reference");
      });

      note.tags.forEach((tag) => {
        pushLink(note.key, `tag:${tag}`, "tag");
      });
    });

    const adjacency = new Map();
    nodes.forEach((node) => adjacency.set(node.id, new Set()));
    links.forEach((link) => {
      adjacency.get(link.source)?.add(link.target);
      adjacency.get(link.target)?.add(link.source);
    });
    nodes.forEach((node) => {
      node.degree = adjacency.get(node.id)?.size || 0;
    });

    const defaultVisibleKeys = Array.isArray(options.initialVisibleKeys) && options.initialVisibleKeys.length > 0
      ? options.initialVisibleKeys
      : knowledge.notes.map((note) => note.key);
    const visibleKeys = new Set(defaultVisibleKeys.filter((key) => nodeById.has(key)));

    let selectedId = "";
    let width = 0;
    let height = 0;
    let currentZoomK = 1;
    let resizeFrame = 0;
    let tickFrame = 0;
    let svg;
    let canvas;
    let linkLayer;
    let nodeLayer;
    let labelLayer;
    let linkSelection;
    let nodeSelection;
    let labelSelection;
    let simulation;
    let zoomBehavior;
    let dragBehavior;
    let activeNodes = [];
    let activeLinks = [];
    let activeNodeIds = new Set();
    const clusterCenters = new Map();
    const tagClusterCenters = new Map();

    const groupPalette = d3.scaleOrdinal()
      .domain(knowledge.groups.map((group) => group.key))
      .range(["#4f76b8", "#c8784d", "#539b8e", "#8270b8", "#7d944c", "#c65f68", "#4f8bae", "#b4789a", "#6e7d8b"]);

    function buildNoteHref(note) {
      return `${linkPrefix}${note.link}`;
    }

    function dispatchEvent(name, detail) {
      document.dispatchEvent(new CustomEvent(name, { detail }));
    }

    function nodeColor(node) {
      if (node.kind === "tag") {
        return "#8c939d";
      }

      return groupPalette(node.note.groupKey);
    }

    function nodeRadius(node) {
      if (node.kind === "tag") {
        return selectedId === node.id ? 10 : clamp(5.5 + Math.sqrt(node.tag.count || 1), 6.5, 9);
      }

      const degree = Math.max(node.note.refs.length + node.note.backlinks.length, node.degree || 0);
      const base = clamp(6.5 + Math.sqrt(degree + 1) * 1.25, 7.5, 13);
      return selectedId === node.id ? base + 3 : base;
    }

    function linkKey(link) {
      return `${linkEndpointId(link.source)}::${linkEndpointId(link.target)}::${link.kind}`;
    }

    function linkVisible(link) {
      const sourceId = linkEndpointId(link.source);
      const targetId = linkEndpointId(link.target);
      return activeNodeIds.has(sourceId) && activeNodeIds.has(targetId);
    }

    function updateFocusPanel(node) {
      if (!focusPanel) {
        return;
      }

      if (!node) {
        focusPanel.classList.add("empty");
        focusPanel.innerHTML = `
          <p class="graph-focus-copy">${escapeHtml(emptyMessage)}</p>
        `;
        return;
      }

      focusPanel.classList.remove("empty");

      if (node.kind === "tag") {
        const related = node.tag.notes
          .filter((key) => visibleKeys.has(key))
          .slice(0, 6)
          .map((key) => knowledge.byKey.get(key))
          .filter(Boolean)
          .map(
            (note) => `<a class="graph-related-link" href="${escapeHtml(buildNoteHref(note))}">${escapeHtml(note.title)}</a>`,
          )
          .join("");

        focusPanel.innerHTML = `
          <div class="graph-focus-header">
            <span class="graph-focus-type">Tag</span>
            <strong>#${escapeHtml(node.label)}</strong>
          </div>
          <p class="graph-focus-copy">${node.tag.count} notes currently use this tag.</p>
          <div class="graph-related-list">${related || "<span class='graph-related-empty'>No linked notes.</span>"}</div>
        `;
        return;
      }

      const note = node.note;
      const tags = note.tags
        .map((tag) => `<button type="button" class="graph-inline-tag" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</button>`)
        .join("");

      focusPanel.innerHTML = `
        <div class="graph-focus-header">
          <span class="graph-focus-type">${escapeHtml(note.groupLabel)}</span>
          <strong>${escapeHtml(note.title)}</strong>
        </div>
        <p class="graph-focus-copy">${escapeHtml(note.summary || "No summary yet.")}</p>
        <div class="graph-focus-meta">
          <span>${escapeHtml(note.date || "--")}</span>
          <span>${note.refs.length} refs</span>
          <span>${note.backlinks.length} backlinks</span>
        </div>
        <div class="graph-inline-tags">${tags}</div>
        <a class="graph-open-link" href="${escapeHtml(buildNoteHref(note))}" data-note-key="${escapeHtml(note.key)}">Open note</a>
      `;

      focusPanel.querySelectorAll(".graph-inline-tag").forEach((button) => {
        button.addEventListener("click", () => {
          if (dispatchTagEvents) {
            dispatchEvent("knowledge:apply-tag", {
              tag: button.dataset.tag || "",
            });
          }
        });
      });

      if (onNoteOpen) {
        const openLink = focusPanel.querySelector(".graph-open-link");
        if (openLink) {
          openLink.addEventListener("click", (event) => {
            event.preventDefault();
            onNoteOpen(note);
          });
        }
      }
    }

    function isNodeVisible(node) {
      if (!node) {
        return false;
      }

      if (node.kind === "tag") {
        return tagsVisible && node.tag.notes.some((key) => visibleKeys.has(key));
      }

      return visibleKeys.has(node.key);
    }

    function visibleNoteCount() {
      let count = 0;
      visibleKeys.forEach((key) => {
        if (nodeById.has(key)) count += 1;
      });
      return count;
    }

    function updateToolbarStatus(noteCount = visibleNoteCount()) {
      if (!toolbarStatus) {
        return;
      }
      const nodeCount = activeNodes.length || noteCount;
      toolbarStatus.textContent = tagsVisible
        ? `${noteCount} notes / ${nodeCount} nodes`
        : `${noteCount} notes`;
    }

    function sortedVisibleGroupKeys() {
      const keys = new Set();
      activeNodes.forEach((node) => {
        if (node.kind === "note") {
          keys.add(node.note.groupKey || "notes");
        }
      });
      return Array.from(keys).sort((a, b) => a.localeCompare(b));
    }

    function updateClusterCenters() {
      clusterCenters.clear();
      tagClusterCenters.clear();

      const groupKeys = sortedVisibleGroupKeys();
      if (groupKeys.length === 0) {
        return;
      }

      const count = groupKeys.length;
      const cols = Math.max(1, Math.ceil(Math.sqrt(count * (width / Math.max(height, 1)))));
      const rows = Math.max(1, Math.ceil(count / cols));
      const usableWidth = Math.max(260, width - 150);
      const usableHeight = Math.max(220, height - 130);
      const startX = (width - usableWidth) / 2;
      const startY = (height - usableHeight) / 2;

      groupKeys.forEach((key, index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);
        const x = startX + usableWidth * ((col + 0.5) / cols);
        const y = startY + usableHeight * ((row + 0.5) / rows);
        clusterCenters.set(key, { x, y });
      });

      activeNodes.forEach((node) => {
        if (node.kind !== "tag") {
          return;
        }

        const groupCounts = new Map();
        node.tag.notes.forEach((key) => {
          if (!visibleKeys.has(key)) {
            return;
          }
          const note = knowledge.byKey.get(key);
          const groupKey = note?.groupKey || "notes";
          groupCounts.set(groupKey, (groupCounts.get(groupKey) || 0) + 1);
        });

        let x = 0;
        let y = 0;
        let total = 0;
        groupCounts.forEach((countForGroup, groupKey) => {
          const center = clusterCenters.get(groupKey);
          if (!center) {
            return;
          }
          x += center.x * countForGroup;
          y += center.y * countForGroup;
          total += countForGroup;
        });

        if (total > 0) {
          tagClusterCenters.set(node.id, { x: x / total, y: y / total });
        }
      });
    }

    function nodeClusterCenter(node) {
      if (node.kind === "tag") {
        return tagClusterCenters.get(node.id) || { x: width / 2, y: height / 2 };
      }
      return clusterCenters.get(node.note.groupKey || "notes") || { x: width / 2, y: height / 2 };
    }

    function labelVisible(node) {
      if (!node || !activeNodeIds.has(node.id)) {
        return false;
      }

      const activeNeighbors = selectedId ? adjacency.get(selectedId) || new Set() : new Set();
      if (selectedId) {
        return node.id === selectedId || activeNeighbors.has(node.id);
      }

      if (node.kind === "tag") {
        return tagsVisible && (activeNodes.length <= 160 || currentZoomK >= 1.45) && (node.tag.count || 0) >= 2;
      }

      if (activeNodes.length <= 120) return true;
      if (activeNodes.length <= 260) return currentZoomK >= 0.9 || (node.degree || 0) >= 2;
      if (activeNodes.length <= 520) return currentZoomK >= 1.35 || (node.degree || 0) >= 4;
      return currentZoomK >= 1.7 || (node.degree || 0) >= 7;
    }

    function updateLabelSelection() {
      if (!labelLayer) {
        return;
      }

      labelSelection = labelLayer
        .selectAll("text")
        .data(activeNodes.filter(labelVisible), (node) => node.id)
        .join(
          (enter) => enter
            .append("text")
            .attr("class", (node) => `graph-label graph-label-${node.kind}`)
            .text((node) => node.label)
            .attr("font-size", (node) => (node.kind === "tag" ? 10 : 11))
            .attr("font-weight", (node) => (node.kind === "tag" ? 560 : 680))
            .attr("pointer-events", "none"),
          (update) => update,
          (exit) => exit.remove(),
        );
    }

    function renderTick() {
      tickFrame = 0;

      if (!linkSelection || !nodeSelection || !labelSelection) {
        return;
      }

      linkSelection
        .attr("x1", (link) => link.source.x)
        .attr("y1", (link) => link.source.y)
        .attr("x2", (link) => link.target.x)
        .attr("y2", (link) => link.target.y);

      nodeSelection
        .attr("cx", (node) => node.x)
        .attr("cy", (node) => node.y);

      labelSelection
        .attr("x", (node) => node.x + nodeRadius(node) + 4)
        .attr("y", (node) => node.y + 4);
    }

    function scheduleTickRender() {
      if (tickFrame) {
        return;
      }
      tickFrame = window.requestAnimationFrame(renderTick);
    }

    function applyStyles() {
      const activeNeighbors = selectedId ? adjacency.get(selectedId) || new Set() : new Set();
      updateLabelSelection();

      nodeSelection
        .style("opacity", (node) => {
          if (!selectedId) return node.kind === "tag" ? 0.82 : 0.98;
          if (node.id === selectedId || activeNeighbors.has(node.id)) return 1;
          return node.kind === "tag" ? 0.22 : 0.34;
        })
        .attr("r", nodeRadius)
        .attr("fill", nodeColor)
        .attr("stroke", (node) => {
          if (selectedId === node.id) return "#1f2937";
          return node.kind === "tag" ? "#f8fafc" : "rgba(255,255,255,0.94)";
        })
        .attr("stroke-width", (node) => (selectedId === node.id ? 2.6 : node.kind === "tag" ? 1.2 : 1.5));

      labelSelection
        .style("opacity", (node) => {
          if (!selectedId) return node.kind === "note" ? 0.92 : 0.66;
          if (node.id === selectedId || activeNeighbors.has(node.id)) return 1;
          return 0.18;
        })
        .attr("fill", (node) => (node.kind === "tag" ? "#6f737c" : "#20262f"));

      linkSelection
        .style("opacity", (link) => {
          const sourceId = linkEndpointId(link.source);
          const targetId = linkEndpointId(link.target);

          if (!selectedId) return link.kind === "reference" ? 0.72 : 0.38;
          if (sourceId === selectedId || targetId === selectedId) return 0.94;
          if (activeNeighbors.has(sourceId) && activeNeighbors.has(targetId)) return 0.48;
          return 0.12;
        })
        .attr("stroke-width", (link) => {
          const sourceId = linkEndpointId(link.source);
          const targetId = linkEndpointId(link.target);
          const selectedLink = selectedId && (sourceId === selectedId || targetId === selectedId);
          if (link.kind === "reference") return selectedLink ? 2.7 : 1.85;
          return selectedLink ? 1.8 : 1.15;
        })
        .attr("stroke", (link) => (link.kind === "reference" ? "#596a82" : "#a3abb6"));
      renderTick();
    }

    function setSelected(node, { dispatch = true } = {}) {
      selectedId = node ? node.id : "";
      updateFocusPanel(node || null);
      applyStyles();

      if (dispatch && node && node.kind === "note" && dispatchFocusEvents) {
        dispatchEvent("knowledge:focus-note", { key: node.key });
      }
    }

    function fitToNodes(predicate) {
      const matching = activeNodes.filter((node) => predicate(node) && typeof node.x === "number" && typeof node.y === "number");
      if (matching.length === 0) {
        return;
      }

      const minX = d3.min(matching, (node) => node.x);
      const maxX = d3.max(matching, (node) => node.x);
      const minY = d3.min(matching, (node) => node.y);
      const maxY = d3.max(matching, (node) => node.y);
      const boxWidth = Math.max(maxX - minX, 80);
      const boxHeight = Math.max(maxY - minY, 80);
      const scale = Math.min(2.2, 0.88 / Math.max(boxWidth / width, boxHeight / height));
      const translateX = width / 2 - scale * (minX + maxX) / 2;
      const translateY = height / 2 - scale * (minY + maxY) / 2;

      svg.transition().duration(300).call(
        zoomBehavior.transform,
        d3.zoomIdentity.translate(translateX, translateY).scale(scale),
      );
    }

    function wheelDeltaPixels(event) {
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16;
      if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * Math.max(height, 320);
      return event.deltaY;
    }

    function zoomAtWheel(event) {
      if (!svg || !zoomBehavior) return;
      event.preventDefault();
      event.stopPropagation();

      const node = svg.node();
      if (!node) return;

      const pointer = d3.pointer(event, node);
      const current = d3.zoomTransform(node);
      const factor = Math.exp(-wheelDeltaPixels(event) * 0.0015);
      const nextK = clamp(current.k * factor, 0.32, 3.2);
      if (Math.abs(nextK - current.k) < 0.001) return;

      const graphX = (pointer[0] - current.x) / current.k;
      const graphY = (pointer[1] - current.y) / current.k;
      const nextTransform = d3.zoomIdentity
        .translate(pointer[0] - graphX * nextK, pointer[1] - graphY * nextK)
        .scale(nextK);

      svg.call(zoomBehavior.transform, nextTransform);
    }

    function refitGraph(predicate, clearSelection = false) {
      if (clearSelection) {
        setSelected(null, { dispatch: false });
      }

      simulation.alpha(activeNodes.length > 380 ? 0.28 : 0.46).restart();
      window.clearTimeout(refitGraph.timerId);
      refitGraph.timerId = window.setTimeout(() => fitToNodes(predicate), activeNodes.length > 360 ? 260 : 180);
    }

    function measureContainerSize() {
      const nextWidth = Math.max(320, Math.round(container.clientWidth || 900));
      const nextHeight = Math.max(240, Math.round(container.clientHeight || 520));
      return { width: nextWidth, height: nextHeight };
    }

    let toolbarEl = null;
    let toolbarSearchInput = null;
    let toolbarStatus = null;
    let toolbarSuggestionBox = null;
    let toolbarSuggestions = [];
    let toolbarActiveSuggestionIndex = -1;
    let toolbarClickListener = null;
    let searchFilterTimer = 0;

    function uniqueSorted(values) {
      return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)))
        .sort((a, b) => a.localeCompare(b));
    }

    function quoteSearchValue(value) {
      const text = String(value || "");
      if (/[\s"]/u.test(text)) {
        return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
      }
      return text;
    }

    function graphSuggestionSources() {
      const notes = Array.isArray(knowledge.notes) ? knowledge.notes : [];
      return {
        tag: uniqueSorted((knowledge.tags || []).map((tag) => tag.name)),
        alias: uniqueSorted(notes.flatMap((note) => note.aliases || [])),
        path: uniqueSorted(notes.map((note) => note.path).filter(Boolean)),
        title: uniqueSorted(notes.map((note) => note.title).filter(Boolean)),
        group: uniqueSorted(notes.flatMap((note) => [note.groupKey, note.groupLabel]).filter(Boolean)),
        section: uniqueSorted(notes.map((note) => note.section).filter(Boolean)),
      };
    }

    function graphSuggestionField(token) {
      const raw = String(token || "");
      const lower = raw.toLowerCase();
      if (lower.startsWith("#")) {
        return { field: "tag", query: lower.slice(1), sigil: "#" };
      }

      const match = lower.match(/^([a-z]+):(.*)$/);
      if (!match) {
        return null;
      }

      const aliases = {
        tags: "tag",
        aka: "alias",
        aliases: "alias",
        file: "path",
        folder: "group",
      };
      const field = aliases[match[1]] || match[1];
      if (!["tag", "alias", "path", "title", "group", "section"].includes(field)) {
        return null;
      }

      return { field, query: match[2], sigil: "" };
    }

    function currentSearchToken() {
      if (!toolbarSearchInput) {
        return null;
      }

      const value = toolbarSearchInput.value;
      const cursor = toolbarSearchInput.selectionStart ?? value.length;
      let start = cursor;
      let end = cursor;

      while (start > 0 && !/\s/u.test(value[start - 1])) start -= 1;
      while (end < value.length && !/\s/u.test(value[end])) end += 1;

      return {
        value,
        start,
        end,
        token: value.slice(start, end),
      };
    }

    function buildGraphSuggestions() {
      const tokenInfo = currentSearchToken();
      if (!tokenInfo) {
        return [];
      }

      const token = tokenInfo.token;
      const lowerToken = token.toLowerCase();
      const sources = graphSuggestionSources();
      const field = graphSuggestionField(token);
      const fieldLabels = [
        { field: "tag", label: "tag:", detail: "filter by tag" },
        { field: "alias", label: "alias:", detail: "filter by alias" },
        { field: "path", label: "path:", detail: "filter by path" },
        { field: "title", label: "title:", detail: "filter by title" },
        { field: "group", label: "group:", detail: "filter by folder/group" },
        { field: "section", label: "section:", detail: "filter by section" },
      ];

      if (field) {
        return (sources[field.field] || [])
          .filter((value) => value.toLowerCase().includes(field.query))
          .slice(0, 10)
          .map((value) => ({
            field: field.field,
            label: field.sigil ? `${field.sigil}${value}` : `${field.field}:${value}`,
            detail: field.field,
            replacement: field.sigil
              ? `${field.sigil}${quoteSearchValue(value)}`
              : `${field.field}:${quoteSearchValue(value)}`,
          }));
      }

      const fieldSuggestions = fieldLabels
        .filter((item) => item.label.startsWith(lowerToken))
        .map((item) => ({
          ...item,
          replacement: item.label,
        }));

      if (!lowerToken) {
        return fieldSuggestions;
      }

      const valueSuggestions = [
        ...sources.tag
          .filter((value) => value.toLowerCase().includes(lowerToken))
          .slice(0, 5)
          .map((value) => ({
            field: "tag",
            label: `tag:${value}`,
            detail: "tag",
            replacement: `tag:${quoteSearchValue(value)}`,
          })),
        ...sources.alias
          .filter((value) => value.toLowerCase().includes(lowerToken))
          .slice(0, 3)
          .map((value) => ({
            field: "alias",
            label: `alias:${value}`,
            detail: "alias",
            replacement: `alias:${quoteSearchValue(value)}`,
          })),
        ...sources.path
          .filter((value) => value.toLowerCase().includes(lowerToken))
          .slice(0, 3)
          .map((value) => ({
            field: "path",
            label: `path:${value}`,
            detail: "path",
            replacement: `path:${quoteSearchValue(value)}`,
          })),
      ];

      return [...fieldSuggestions, ...valueSuggestions].slice(0, 12);
    }

    function closeToolbarSuggestions() {
      toolbarSuggestions = [];
      toolbarActiveSuggestionIndex = -1;
      if (toolbarSuggestionBox) {
        toolbarSuggestionBox.hidden = true;
        toolbarSuggestionBox.innerHTML = "";
      }
      if (toolbarSearchInput) {
        toolbarSearchInput.setAttribute("aria-expanded", "false");
      }
    }

    function setActiveToolbarSuggestion(index) {
      if (!toolbarSuggestionBox || toolbarSuggestions.length === 0) {
        toolbarActiveSuggestionIndex = -1;
        return;
      }

      toolbarActiveSuggestionIndex = (index + toolbarSuggestions.length) % toolbarSuggestions.length;
      toolbarSuggestionBox.querySelectorAll(".graph-toolbar-suggestion").forEach((button, buttonIndex) => {
        const active = buttonIndex === toolbarActiveSuggestionIndex;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-selected", active ? "true" : "false");
      });
    }

    function applyToolbarSuggestion(suggestion) {
      const tokenInfo = currentSearchToken();
      if (!tokenInfo || !suggestion || !toolbarSearchInput) {
        return;
      }

      const before = tokenInfo.value.slice(0, tokenInfo.start);
      const after = tokenInfo.value.slice(tokenInfo.end).replace(/^\s+/u, "");
      const needsTrailingSpace = suggestion.replacement.endsWith(":") ? "" : " ";
      const nextValue = `${before}${suggestion.replacement}${needsTrailingSpace}${after}`;
      const nextCursor = before.length + suggestion.replacement.length + needsTrailingSpace.length;

      toolbarSearchInput.value = nextValue;
      toolbarSearchInput.focus();
      toolbarSearchInput.setSelectionRange(nextCursor, nextCursor);
      closeToolbarSuggestions();
      applySearchFilter(nextValue);
    }

    function showToolbarSuggestions() {
      if (!toolbarSuggestionBox || !toolbarSearchInput) {
        return;
      }

      toolbarSuggestions = buildGraphSuggestions();
      toolbarActiveSuggestionIndex = -1;

      if (toolbarSuggestions.length === 0) {
        closeToolbarSuggestions();
        return;
      }

      toolbarSuggestionBox.innerHTML = toolbarSuggestions
        .map((suggestion, index) => `
          <button type="button" class="graph-toolbar-suggestion" data-index="${index}" role="option" aria-selected="false">
            <span>${escapeHtml(suggestion.label)}</span>
            <small>${escapeHtml(suggestion.detail)}</small>
          </button>
        `)
        .join("");
      toolbarSuggestionBox.hidden = false;
      toolbarSearchInput.setAttribute("aria-expanded", "true");

      toolbarSuggestionBox.querySelectorAll(".graph-toolbar-suggestion").forEach((button) => {
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", () => {
          applyToolbarSuggestion(toolbarSuggestions[Number(button.dataset.index)]);
        });
      });
    }

    function applySearchFilter(rawText, { refit = true } = {}) {
      const text = String(rawText || "").trim();
      if (!text) {
        setVisibleKeys(knowledge.notes.map((note) => note.key), { refit });
        updateToolbarStatus(knowledge.notes.length);
        return;
      }
      const matched = knowledge.filterNotes
        ? knowledge.filterNotes({ text, includeHidden: true })
        : knowledge.notes;
      setVisibleKeys(matched.map((note) => note.key), { refit });
      updateToolbarStatus(matched.length);
    }

    function buildToolbar() {
      if (!wantToolbar) {
        return;
      }
      if (window.getComputedStyle(container).position === "static") {
        container.style.position = "relative";
      }
      toolbarEl = document.createElement("div");
      toolbarEl.className = "graph-toolbar";
      toolbarEl.innerHTML = `
        <input type="search" class="graph-toolbar-input" placeholder="Search title, body, tag:, alias:, path:" autocomplete="off" aria-autocomplete="list" aria-expanded="false" />
        <span class="graph-toolbar-status">${knowledge.notes.length} notes</span>
        <button type="button" class="graph-toolbar-btn ${tagsVisible ? "is-active" : ""}" data-action="tags" aria-pressed="${tagsVisible ? "true" : "false"}" title="Show or hide tag nodes">Tags</button>
        <button type="button" class="graph-toolbar-btn" data-action="center" title="Center on visible">Center</button>
        <button type="button" class="graph-toolbar-btn" data-action="reset" title="Reset filter">Reset</button>
        <div class="graph-toolbar-suggestions" role="listbox" hidden></div>
      `;
      container.appendChild(toolbarEl);

      toolbarSearchInput = toolbarEl.querySelector(".graph-toolbar-input");
      toolbarStatus = toolbarEl.querySelector(".graph-toolbar-status");
      toolbarSuggestionBox = toolbarEl.querySelector(".graph-toolbar-suggestions");
      const initialSearchText = String(options.initialSearchText || "");
      if (initialSearchText) {
        toolbarSearchInput.value = initialSearchText;
      }
      toolbarSearchInput.addEventListener("input", (event) => {
        const value = event.target.value;
        window.clearTimeout(searchFilterTimer);
        searchFilterTimer = window.setTimeout(() => applySearchFilter(value), 140);
        showToolbarSuggestions();
      });
      toolbarSearchInput.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" && toolbarSuggestions.length > 0) {
          event.preventDefault();
          setActiveToolbarSuggestion(toolbarActiveSuggestionIndex + 1);
          return;
        }
        if (event.key === "ArrowUp" && toolbarSuggestions.length > 0) {
          event.preventDefault();
          setActiveToolbarSuggestion(toolbarActiveSuggestionIndex - 1);
          return;
        }
        if (event.key === "Enter" && toolbarActiveSuggestionIndex >= 0) {
          event.preventDefault();
          applyToolbarSuggestion(toolbarSuggestions[toolbarActiveSuggestionIndex]);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          if (toolbarSuggestionBox && !toolbarSuggestionBox.hidden) {
            closeToolbarSuggestions();
            return;
          }
          toolbarSearchInput.value = "";
          applySearchFilter("");
        }
      });
      toolbarSearchInput.addEventListener("focus", showToolbarSuggestions);
      if (toolbarClickListener) {
        document.removeEventListener("click", toolbarClickListener);
      }
      toolbarClickListener = (event) => {
        if (toolbarEl && !toolbarEl.contains(event.target)) {
          closeToolbarSuggestions();
        }
      };
      document.addEventListener("click", toolbarClickListener);

      toolbarEl.querySelector('[data-action="tags"]').addEventListener("click", (event) => {
        tagsVisible = !tagsVisible;
        event.currentTarget.classList.toggle("is-active", tagsVisible);
        event.currentTarget.setAttribute("aria-pressed", tagsVisible ? "true" : "false");
        updateActiveGraph({ restart: true });
        if (selectedId && !activeNodeIds.has(selectedId)) {
          setSelected(null, { dispatch: false });
        } else {
          applyStyles();
        }
        refitGraph((node) => isNodeVisible(node), false);
      });
      toolbarEl.querySelector('[data-action="center"]').addEventListener("click", () => {
        refitGraph((node) => isNodeVisible(node), false);
      });
      toolbarEl.querySelector('[data-action="reset"]').addEventListener("click", () => {
        if (toolbarSearchInput) toolbarSearchInput.value = "";
        closeToolbarSuggestions();
        applySearchFilter("", { refit: false });
        refitGraph((node) => isNodeVisible(node), true);
      });
    }

    function linkDistance(link) {
      if (link.kind === "tag") {
        return activeNodes.length > 420 ? 42 : 54;
      }
      return activeNodes.length > 420 ? 74 : 88;
    }

    function linkStrength(link) {
      return link.kind === "reference" ? 0.46 : 0.22;
    }

    function chargeStrength(node) {
      const largeGraphScale = activeNodes.length > 480 ? 0.68 : activeNodes.length > 300 ? 0.82 : 1;
      if (node.kind === "tag") {
        return -86 * largeGraphScale;
      }
      return clamp(-166 - (node.degree || 0) * 8, -285, -150) * largeGraphScale;
    }

    function clusterStrength(node) {
      if (node.kind === "tag") {
        return 0.04;
      }
      return activeNodes.length > 420 ? 0.12 : 0.085;
    }

    function configureSimulationForces() {
      updateClusterCenters();
      simulation
        .force("link", d3.forceLink(activeLinks)
          .id((node) => node.id)
          .distance(linkDistance)
          .strength(linkStrength)
          .iterations(activeNodes.length > 280 ? 1 : 2))
        .force("charge", d3.forceManyBody()
          .strength(chargeStrength)
          .theta(0.92)
          .distanceMax(Math.max(260, Math.min(720, Math.max(width, height) * 0.82))))
        .force("center", d3.forceCenter(width / 2, height / 2))
        .force("clusterX", d3.forceX((node) => nodeClusterCenter(node).x).strength(clusterStrength))
        .force("clusterY", d3.forceY((node) => nodeClusterCenter(node).y).strength(clusterStrength))
        .force("collide", d3.forceCollide().radius((node) => nodeRadius(node) + (node.kind === "tag" ? 6 : 8)).iterations(1));
    }

    function updateActiveGraph({ restart = true } = {}) {
      activeNodes = nodes.filter(isNodeVisible);
      activeNodeIds = new Set(activeNodes.map((node) => node.id));
      activeLinks = links.filter(linkVisible);

      if (selectedId && !activeNodeIds.has(selectedId)) {
        selectedId = "";
        updateFocusPanel(null);
      }

      linkSelection = linkLayer
        .selectAll("line")
        .data(activeLinks, linkKey)
        .join(
          (enter) => enter
            .append("line")
            .attr("class", (link) => `graph-link graph-link-${link.kind}`),
          (update) => update,
          (exit) => exit.remove(),
        );

      nodeSelection = nodeLayer
        .selectAll("circle")
        .data(activeNodes, (node) => node.id)
        .join(
          (enter) => enter
            .append("circle")
            .attr("class", (node) => `graph-node graph-node-${node.kind}`)
            .attr("tabindex", 0)
            .attr("cursor", "pointer")
            .on("click", (event, node) => {
              event.stopPropagation();

              if (node.kind === "tag" && dispatchTagEvents) {
                dispatchEvent("knowledge:apply-tag", {
                  tag: node.label,
                });
              }

              setSelected(node);
            })
            .on("dblclick", (event, node) => {
              event.stopPropagation();
              if (node.kind !== "note") {
                return;
              }
              if (onNoteOpen) {
                onNoteOpen(node.note);
              } else {
                window.location.href = buildNoteHref(node.note);
              }
            })
            .call(dragBehavior),
          (update) => update,
          (exit) => exit.remove(),
        );

      simulation.nodes(activeNodes);
      configureSimulationForces();
      updateLabelSelection();
      applyStyles();
      updateToolbarStatus();

      if (restart) {
        simulation.alpha(activeNodes.length > 420 ? 0.34 : 0.58).restart();
      }
    }

    function buildGraph() {
      container.innerHTML = "";
      buildToolbar();
      ({ width, height } = measureContainerSize());

      svg = d3.select(container)
        .append("svg")
        .attr("width", width)
        .attr("height", height)
        .attr("viewBox", [0, 0, width, height]);

      svg.append("rect")
        .attr("class", "graph-hit-area")
        .attr("x", 0)
        .attr("y", 0)
        .attr("width", width)
        .attr("height", height);

      canvas = svg.append("g");
      linkLayer = canvas.append("g").attr("class", "graph-links");
      nodeLayer = canvas.append("g").attr("class", "graph-nodes");
      labelLayer = canvas.append("g").attr("class", "graph-labels");

      zoomBehavior = d3.zoom().scaleExtent([0.32, 3.2]).on("zoom", (event) => {
        canvas.attr("transform", event.transform);
        const previousZoom = currentZoomK;
        currentZoomK = event.transform.k;
        if (Math.abs(previousZoom - currentZoomK) > 0.16) {
          applyStyles();
        }
      });

      svg.call(zoomBehavior);
      svg.node()?.addEventListener("wheel", (event) => {
        zoomAtWheel(event);
      }, { passive: false, capture: true });
      svg.on("click", () => setSelected(null, { dispatch: false }));

      dragBehavior = d3.drag()
        .on("start", (event) => {
          if (!event.active) simulation.alphaTarget(0.14).restart();
          event.subject.fx = event.subject.x;
          event.subject.fy = event.subject.y;
        })
        .on("drag", (event) => {
          event.subject.fx = event.x;
          event.subject.fy = event.y;
        })
        .on("end", (event) => {
          if (!event.active) simulation.alphaTarget(0);
          event.subject.fx = null;
          event.subject.fy = null;
        });

      simulation = d3.forceSimulation()
        .velocityDecay(0.44)
        .alphaDecay(0.075)
        .on("tick", scheduleTickRender);

      updateActiveGraph({ restart: false });
      simulation.alpha(1).restart();
      updateFocusPanel(null);
      if (toolbarSearchInput && toolbarSearchInput.value.trim()) {
        applySearchFilter(toolbarSearchInput.value);
      }

      const initialSelectedId = String(options.initialSelectedId || "");
      if (initialSelectedId && nodeById.has(initialSelectedId)) {
        window.setTimeout(() => {
          setSelected(nodeById.get(initialSelectedId), { dispatch: false });
          refitGraph((node) => {
            if (!isNodeVisible(node)) {
              return false;
            }

            if (node.id === initialSelectedId) {
              return true;
            }

            return (adjacency.get(initialSelectedId) || new Set()).has(node.id);
          }, false);
        }, 260);
      } else {
        window.setTimeout(() => refitGraph((node) => isNodeVisible(node), true), 260);
      }
    }

    function resizeGraph() {
      if (!simulation || !svg) {
        return;
      }

      const nextSize = measureContainerSize();
      if (nextSize.width === width && nextSize.height === height) {
        return;
      }

      width = nextSize.width;
      height = nextSize.height;
      svg.attr("width", width).attr("height", height);
      svg.attr("viewBox", [0, 0, width, height]);
      configureSimulationForces();
      simulation.alpha(activeNodes.length > 420 ? 0.24 : 0.38).restart();
    }

    function setVisibleKeys(nextKeys, { refit = true } = {}) {
      visibleKeys.clear();
      (Array.isArray(nextKeys) ? nextKeys : []).forEach((key) => {
        if (nodeById.has(key)) {
          visibleKeys.add(key);
        }
      });

      updateActiveGraph({ restart: false });

      if (refit) {
        refitGraph((node) => isNodeVisible(node), false);
      }
    }

    function selectById(id, { fit = true, dispatch = false } = {}) {
      const node = nodeById.get(id);
      if (!node) {
        return;
      }

      setSelected(node, { dispatch });

      if (fit) {
        refitGraph((candidate) => {
          if (!isNodeVisible(candidate)) {
            return false;
          }

          if (candidate.id === id) {
            return true;
          }

          return (adjacency.get(id) || new Set()).has(candidate.id);
        }, false);
      }
    }

    function recenter() {
      refitGraph((node) => isNodeVisible(node), false);
    }

    function setSearchQuery(query, { focus = false, refit = true } = {}) {
      const text = String(query || "");
      if (!toolbarSearchInput) {
        setVisibleKeys(knowledge.filterNotes
          ? knowledge.filterNotes({ text, includeHidden: true }).map((note) => note.key)
          : knowledge.notes.map((note) => note.key), { refit });
        return;
      }
      toolbarSearchInput.value = text;
      closeToolbarSuggestions();
      applySearchFilter(text, { refit });
      if (focus) {
        toolbarSearchInput.focus();
        toolbarSearchInput.select();
      }
    }

    const resizeObserver = new ResizeObserver(() => {
      if (resizeFrame) {
        window.cancelAnimationFrame(resizeFrame);
      }
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = 0;
        resizeGraph();
      });
    });
    resizeObserver.observe(container);

    let filtersListener = null;
    if (listenForGlobalFilters) {
      filtersListener = (event) => {
        setVisibleKeys(
          event.detail && Array.isArray(event.detail.visibleKeys)
            ? event.detail.visibleKeys
            : knowledge.notes.map((note) => note.key),
          { refit: false },
        );

        window.clearTimeout(refitGraph.timerId);
        refitGraph.timerId = window.setTimeout(() => {
          refitGraph((node) => isNodeVisible(node), false);
        }, 120);
      };

      document.addEventListener("knowledge:filters-changed", filtersListener);
    }

    buildGraph();

    const api = {
      container,
      focusPanel,
      setVisibleKeys,
      setSearchQuery,
      selectById,
      recenter,
      destroy() {
        resizeObserver.disconnect();
        window.clearTimeout(searchFilterTimer);
        window.clearTimeout(refitGraph.timerId);
        if (resizeFrame) {
          window.cancelAnimationFrame(resizeFrame);
        }
        if (tickFrame) {
          window.cancelAnimationFrame(tickFrame);
        }
        if (filtersListener) {
          document.removeEventListener("knowledge:filters-changed", filtersListener);
        }
        if (toolbarClickListener) {
          document.removeEventListener("click", toolbarClickListener);
          toolbarClickListener = null;
        }
        if (simulation) {
          simulation.stop();
        }
        delete container._knowledgeGraph;
        delete container.dataset.graphMounted;
      },
    };

    container.dataset.graphMounted = "true";
    container._knowledgeGraph = api;
    return api;
  }

  function injectToolbarStyles() {
    if (document.getElementById("graph-toolbar-styles")) {
      return;
    }
    const style = document.createElement("style");
    style.id = "graph-toolbar-styles";
    style.textContent = `
      #graph-container,
      .graph-container {
        position: relative;
        min-height: 560px;
        overflow: hidden;
        overscroll-behavior: contain;
        border: 1px solid color-mix(in srgb, var(--aaron-paper-line, #d8d0c2), #8792a2 18%);
        background:
          radial-gradient(circle at 18px 18px, rgba(91, 102, 121, 0.10) 1px, transparent 1.4px),
          linear-gradient(180deg, color-mix(in srgb, var(--aaron-paper, #fffaf0), white 22%), color-mix(in srgb, var(--aaron-paper-soft, #f8f4ea), white 10%)),
          var(--aaron-paper, #fffaf0);
        background-size: 28px 28px, auto, auto;
        box-shadow: inset 0 0 0 1px color-mix(in srgb, white, transparent 45%);
      }
      #graph-container svg,
      .graph-container svg {
        display: block;
        width: 100%;
        height: 100%;
        min-height: inherit;
        touch-action: none;
      }
      .graph-hit-area {
        fill: transparent;
        pointer-events: all;
      }
      .graph-message {
        display: grid;
        min-height: 220px;
        place-items: center;
        color: var(--aaron-muted, #6f6a61);
        font: 13px/1.4 var(--aaron-font-sans, system-ui, sans-serif);
      }
      .graph-links line {
        stroke-linecap: round;
        vector-effect: non-scaling-stroke;
      }
      .graph-node {
        vector-effect: non-scaling-stroke;
      }
      .graph-node-tag {
        fill: #8c939d;
      }
      .graph-labels text {
        paint-order: stroke;
        stroke: rgba(255, 255, 255, 0.82);
        stroke-width: 4px;
        stroke-linejoin: round;
      }
      .graph-label-tag {
        fill: #6f737c;
      }
      .graph-toolbar {
        position: absolute;
        top: 10px;
        left: 10px;
        z-index: 5;
        display: flex;
        align-items: center;
        gap: 7px;
        max-width: calc(100% - 16px);
        background: color-mix(in srgb, var(--aaron-paper, #fffaf0), white 20%);
        border: 1px solid color-mix(in srgb, var(--aaron-paper-line, #d8d0c2), #8792a2 18%);
        border-radius: 4px;
        padding: 5px 7px;
        font: 12px/1.2 var(--aaron-font-sans, system-ui, -apple-system, "Helvetica Neue", sans-serif);
        box-shadow: 0 8px 24px rgba(30, 24, 18, 0.10);
      }
      .graph-toolbar-input {
        width: min(360px, 42vw);
        height: 30px;
        box-sizing: border-box;
        border: 1px solid color-mix(in srgb, var(--aaron-paper-line, #d8d0c2), #8792a2 20%);
        border-radius: 3px;
        padding: 0 8px;
        background: color-mix(in srgb, var(--aaron-paper, #fffaf0), white 28%);
        color: var(--aaron-ink, #24201a);
        font: inherit;
        outline: none;
      }
      .graph-toolbar-input:focus {
        border-color: var(--aaron-red, #b8202a);
      }
      .graph-toolbar-status {
        color: var(--aaron-muted, #6f6a61);
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      .graph-toolbar-btn {
        min-height: 30px;
        border: 1px solid color-mix(in srgb, var(--aaron-paper-line, #d8d0c2), #8792a2 20%);
        background: color-mix(in srgb, var(--aaron-paper-soft, #f8f4ea), white 22%);
        color: var(--aaron-ink, #24201a);
        border-radius: 3px;
        padding: 0 9px;
        cursor: pointer;
        font: inherit;
      }
      .graph-toolbar-btn:hover {
        border-color: var(--aaron-red, #b8202a);
        background: var(--aaron-paper, #fffaf0);
      }
      .graph-toolbar-btn.is-active {
        border-color: color-mix(in srgb, var(--aaron-red, #b8202a), #6b7280 40%);
        background: color-mix(in srgb, var(--aaron-paper-soft, #f8f4ea), var(--aaron-red, #b8202a) 10%);
      }
      .graph-toolbar-suggestions {
        position: absolute;
        top: calc(100% + 4px);
        left: 4px;
        width: min(360px, calc(100vw - 24px));
        max-height: min(320px, calc(100vh - 96px));
        overflow: auto;
        background: color-mix(in srgb, var(--aaron-paper, #fffaf0), white 18%);
        border: 1px solid color-mix(in srgb, var(--aaron-paper-line, #d8d0c2), #8792a2 18%);
        border-radius: 4px;
        box-shadow: 0 14px 32px rgba(30, 24, 18, 0.16);
        padding: 4px;
      }
      .graph-toolbar-suggestion {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        width: 100%;
        border: 0;
        border-radius: 3px;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font: inherit;
        padding: 5px 7px;
        text-align: left;
      }
      .graph-toolbar-suggestion small {
        color: var(--aaron-muted, #6f6a61);
        flex: 0 0 auto;
      }
      .graph-toolbar-suggestion:hover,
      .graph-toolbar-suggestion.is-active {
        background: color-mix(in srgb, var(--aaron-paper-soft, #f8f4ea), var(--aaron-red, #b8202a) 7%);
      }
      .graph-focus {
        box-sizing: border-box;
        border: 1px solid color-mix(in srgb, var(--aaron-paper-line, #d8d0c2), #8792a2 18%);
        background: color-mix(in srgb, var(--aaron-paper, #fffaf0), white 12%);
        padding: 16px;
        color: var(--aaron-ink, #24201a);
        font: 13px/1.55 var(--aaron-font-sans, system-ui, sans-serif);
      }
      .graph-focus.empty,
      .graph-related-empty {
        color: var(--aaron-muted, #6f6a61);
      }
      .graph-focus-header {
        display: grid;
        gap: 5px;
        margin-bottom: 10px;
      }
      .graph-focus-type {
        color: var(--aaron-muted, #6f6a61);
        font: 700 11px/1.2 var(--aaron-font-sans, system-ui, sans-serif);
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .graph-focus-header strong {
        color: var(--aaron-red-dark, #8d1f26);
        font: 760 18px/1.18 var(--aaron-font-sans, system-ui, sans-serif);
      }
      .graph-focus-copy {
        margin: 0 0 12px;
        color: var(--aaron-ink, #24201a);
      }
      .graph-focus-meta,
      .graph-inline-tags,
      .graph-related-list {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin: 0 0 12px;
      }
      .graph-focus-meta span,
      .graph-inline-tag,
      .graph-related-link,
      .graph-open-link {
        border: 1px solid color-mix(in srgb, var(--aaron-paper-line, #d8d0c2), #8792a2 16%);
        border-radius: 3px;
        background: color-mix(in srgb, var(--aaron-paper-soft, #f8f4ea), white 20%);
        color: var(--aaron-ink, #24201a);
        text-decoration: none;
      }
      .graph-focus-meta span,
      .graph-inline-tag {
        min-height: 24px;
        padding: 3px 7px;
        font: 650 12px/1.3 var(--aaron-font-sans, system-ui, sans-serif);
      }
      .graph-inline-tag {
        cursor: pointer;
        color: #5f6670;
        background: color-mix(in srgb, var(--aaron-paper-soft, #f8f4ea), #8c939d 11%);
      }
      .graph-related-link,
      .graph-open-link {
        display: inline-flex;
        align-items: center;
        min-height: 30px;
        padding: 0 10px;
      }
      .graph-open-link {
        justify-content: center;
        width: 100%;
        box-sizing: border-box;
        color: var(--aaron-red-dark, #8d1f26);
        font-weight: 750;
      }
      .graph-inline-tag:hover,
      .graph-related-link:hover,
      .graph-open-link:hover {
        border-color: var(--aaron-red, #b8202a);
        background: var(--aaron-paper, #fffaf0);
      }
      @media (max-width: 560px) {
        .graph-toolbar {
          right: 8px;
          flex-wrap: wrap;
        }
        .graph-toolbar-input {
          width: 100%;
          min-width: 0;
        }
        .graph-toolbar-suggestions {
          right: 4px;
          width: auto;
        }
      }
    `;
    document.head.appendChild(style);
  }

  injectToolbarStyles();

  window.initKnowledgeGraph = initKnowledgeGraph;

  document.addEventListener("DOMContentLoaded", () => {
    if (window.__GRAPH_NO_AUTO_INIT__) {
      return;
    }
    initKnowledgeGraph();
  });
})();
