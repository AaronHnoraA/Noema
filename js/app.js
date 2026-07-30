document.addEventListener("DOMContentLoaded", () => {
  const knowledge = window.KNOWLEDGE_DATA;
  const app = document.getElementById("app-tabs");
  const searchWrapper = document.querySelector(".search-wrapper");
  const searchInput = document.getElementById("note-search");
  const resetBtn = document.getElementById("reset-search");
  const tagCloud = document.getElementById("tag-cloud");
  const sortSelect = document.getElementById("sort-select");
  const summary = document.getElementById("notes-summary");
  const activeFilters = document.getElementById("active-filters");
  const actions = document.getElementById("notes-actions");
  const currentInterestsPanel = document.getElementById("current-interests-panel");
  const selectedNotesPanel = document.getElementById("selected-notes-panel");
  const recentUpdatesPanel = document.getElementById("recent-updates-panel");

  if (!knowledge || !app || !searchWrapper || !searchInput || !resetBtn || !tagCloud || !sortSelect) {
    return;
  }

  const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  const selectableNotes = knowledge.publicNotes || knowledge.notes;
  const selectableTags = knowledge.publicTags || knowledge.tags;
  const selectableGroups = knowledge.publicGroups || knowledge.groups;
  const suggestionBox = document.createElement("div");
  suggestionBox.className = "autocomplete-suggestions";
  suggestionBox.id = "note-search-suggestions";
  suggestionBox.setAttribute("role", "listbox");
  searchWrapper.appendChild(suggestionBox);
  searchInput.setAttribute("role", "combobox");
  searchInput.setAttribute("aria-autocomplete", "list");
  searchInput.setAttribute("aria-controls", suggestionBox.id);
  searchInput.setAttribute("aria-expanded", "false");

  const state = {
    text: "",
    tags: new Set(),
    sort: "date-desc",
    tab: "",
    focusedKey: "",
  };

  let isComposing = false;
  let debounceTimer = null;
  let pendingScrollKey = "";
  let activeSuggestionIndex = -1;

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function highlightText(text, keyword) {
    if (!keyword) {
      return escapeHtml(text);
    }

    const safeKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(${safeKeyword})`, "gi");
    return escapeHtml(text).replace(regex, "<mark>$1</mark>");
  }

  function applyHighlights(text, query) {
    const terms = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

    if (terms.length === 0) {
      return escapeHtml(text);
    }

    const regex = new RegExp(`(${terms.join("|")})`, "gi");
    return escapeHtml(text).replace(regex, "<mark>$1</mark>");
  }

  function debounce(fn, wait) {
    return (...args) => {
      clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => fn(...args), wait);
    };
  }

  function suggestionItems() {
    return Array.from(suggestionBox.querySelectorAll("[data-suggestion-index]"));
  }

  function closeSuggestions() {
    activeSuggestionIndex = -1;
    suggestionBox.style.display = "none";
    searchInput.setAttribute("aria-expanded", "false");
    searchInput.removeAttribute("aria-activedescendant");
  }

  function openSuggestions() {
    suggestionBox.style.display = "block";
    searchInput.setAttribute("aria-expanded", "true");
  }

  function setActiveSuggestion(index) {
    const items = suggestionItems();

    if (items.length === 0) {
      closeSuggestions();
      return;
    }

    activeSuggestionIndex = ((index % items.length) + items.length) % items.length;
    items.forEach((item, itemIndex) => {
      const isActive = itemIndex === activeSuggestionIndex;
      item.classList.toggle("is-active", isActive);
      item.setAttribute("aria-selected", isActive ? "true" : "false");

      if (isActive) {
        searchInput.setAttribute("aria-activedescendant", item.id);
        item.scrollIntoView({ block: "nearest" });
      }
    });
  }

  function readUrlState() {
    const params = new URLSearchParams(window.location.search);
    state.text = params.get("q") || "";
    state.sort = params.get("sort") || "date-desc";
    state.tab = params.get("tab") || "";
    state.focusedKey = params.get("focus") || "";

    state.tags.clear();
    (params.get("tags") || "")
      .split(",")
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean)
      .forEach((tag) => state.tags.add(tag));

    searchInput.value = state.text;
    sortSelect.value = state.sort;
  }

  function syncUrlState() {
    const params = new URLSearchParams();

    if (state.text) params.set("q", state.text);
    if (state.tags.size > 0) params.set("tags", Array.from(state.tags).join(","));
    if (state.sort !== "date-desc") params.set("sort", state.sort);
    if (state.tab) params.set("tab", state.tab);
    if (state.focusedKey) params.set("focus", state.focusedKey);

    const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", nextUrl);
  }

  function sortFiles(files) {
    return files.slice().sort((a, b) => {
      if (state.text && a._score !== b._score) return b._score - a._score;
      if (state.tags.size > 0 && a._tagScore !== b._tagScore) return b._tagScore - a._tagScore;
      if (state.sort === "date-desc") return b.dateValue - a.dateValue || collator.compare(a.title, b.title);
      if (state.sort === "date-asc") return a.dateValue - b.dateValue || collator.compare(a.title, b.title);
      return collator.compare(a.title, b.title);
    });
  }

  function filterFiles() {
    const terms = state.text.toLowerCase().split(/\s+/).filter(Boolean);
    const filtered = knowledge.filterNotes({ text: state.text, tags: Array.from(state.tags) });

    return filtered.map((note) => {
      let score = knowledge.scoreNote
        ? knowledge.scoreNote(note, state.text, Array.from(state.tags))
        : 0;
      let tagScore = 0;

      if (!knowledge.scoreNote) {
        terms.forEach((term) => {
          if (note.title.toLowerCase().includes(term)) score += 5;
          if (note.aliases && note.aliases.some((alias) => alias.toLowerCase().includes(term))) score += 4;
          if (note.tags.some((tag) => tag.includes(term))) score += 3;
          if (note.summary.toLowerCase().includes(term)) score += 2;
          if ((note.path || "").toLowerCase().includes(term)) score += 1;
          if (note.groupLabel.toLowerCase().includes(term)) score += 1;
        });
      }

      Array.from(state.tags).forEach((tag) => {
        if (note.tags.includes(tag)) {
          tagScore += 2;
        }
      });

      return {
        ...note,
        _score: score,
        _tagScore: tagScore,
      };
    });
  }

  function switchTab(groupKey) {
    state.tab = groupKey;

    document.querySelectorAll(".tab-btn").forEach((button) => {
      const isActive = button.dataset.tab === groupKey;
      button.classList.toggle("active", isActive);
      applyTabButtonStyles(button, isActive);
    });

    document.querySelectorAll(".tab-content").forEach((pane) => {
      pane.classList.toggle("active", pane.dataset.tab === groupKey);
    });
  }

  function applyTabButtonStyles(button, isActive) {
    button.classList.toggle("active", isActive);
  }

  function formatGroupLabel(group) {
    if (!group) {
      return "";
    }

    const fallback = knowledge.inferGroupLabel(group.key || "");
    const explicit = String(group.label || "").trim();

    if (explicit) {
      return explicit;
    }

    if (fallback) {
      return fallback;
    }

    return String(group.key || "").replace(/^roam\//, "");
  }

  function renderAcademicPanels() {
    const qcNotes = selectableNotes.filter((note) => note.groupLabel === "QC" || note.tags.includes("qc"));
    const tcsNotes = selectableNotes.filter((note) => note.tags.includes("tcs") || /tcs|complexity|algorithm/i.test(note.groupLabel));
    const selectedTitles = ["Quantum State", "Density Operator", "Observable & Expectation", "Hilbert Space"];
    const selectedNotes = selectedTitles
      .map((title) => selectableNotes.find((note) => note.title === title))
      .filter(Boolean);
    const recentNotes = selectableNotes
      .slice()
      .sort((a, b) => b.dateValue - a.dateValue || collator.compare(a.title, b.title))
      .slice(0, 4);

    if (currentInterestsPanel) {
      currentInterestsPanel.innerHTML = `
        <div class="academic-track-list">
          <article class="academic-track-row">
            <div class="academic-track-copy">
              <span class="research-kicker">QC</span>
              <h3>Quantum Computing</h3>
              <p>Active note stream with ${qcNotes.length} published notes on states, observables, density operators, and Hilbert-space foundations.</p>
            </div>
            <div class="academic-track-actions">
              <a class="academic-tag" href="notes.html?tags=qc#notes-section">Open QC archive</a>
            </div>
          </article>
          <article class="academic-track-row">
            <div class="academic-track-copy">
              <span class="research-kicker">TCS</span>
              <h3>Theoretical Computer Science</h3>
              <p>${tcsNotes.length > 0 ? `${tcsNotes.length} notes currently published.` : "Archive in preparation, with planned notes on complexity, algorithms, and communication complexity."}</p>
            </div>
            <div class="academic-track-actions">
              <span class="academic-tag academic-tag-muted">Placeholder</span>
            </div>
          </article>
        </div>
      `;
    }

    if (selectedNotesPanel) {
      selectedNotesPanel.innerHTML = `
        <div class="selected-note-list">
          ${selectedNotes
            .map(
              (note) => `
                <article class="selected-note-item">
                  <div class="selected-note-meta">
                    <span>${escapeHtml(note.groupLabel || note.section || "Note")}</span>
                    <span>${escapeHtml(note.date || "--")}</span>
                  </div>
                  <h3><a href="${escapeHtml(note.link)}">${escapeHtml(note.title)}</a></h3>
                  <p>${escapeHtml(note.summary || "Part of the published note archive.")}</p>
                </article>
              `,
            )
            .join("")}
          <article class="selected-note-item placeholder-note-item">
            <div class="selected-note-meta">
              <span>TCS</span>
              <span>Placeholder</span>
            </div>
            <h3>Communication Complexity</h3>
            <p>Planned expository note on models, lower bounds, and matrix viewpoints.</p>
          </article>
        </div>
      `;
    }

    if (recentUpdatesPanel) {
      recentUpdatesPanel.innerHTML = `
        <div class="selected-note-list">
          ${recentNotes
            .map(
              (note) => `
                <article class="selected-note-item">
                  <div class="selected-note-meta">
                    <span>${escapeHtml(note.groupLabel || "Note")}</span>
                    <span>${escapeHtml(note.date || "--")}</span>
                  </div>
                  <h3><a href="${escapeHtml(note.link)}">${escapeHtml(note.title)}</a></h3>
                  <p>${escapeHtml(note.summary || "Part of the published note archive.")}</p>
                </article>
              `,
            )
            .join("")}
        </div>
      `;
    }
  }

  function renderSummary(filtered) {
    if (!summary) {
      return;
    }

    const cards = [
      {
        label: "Archive",
        value: knowledge.stats.totalNotes,
        hint: `${knowledge.stats.connectedNotes} connected`,
      },
      {
        label: "Visible",
        value: filtered.length,
        hint: state.text || state.tags.size ? "filtered selection" : "full archive",
      },
      {
        label: "Topics",
        value: knowledge.stats.totalTags,
        hint: `${knowledge.stats.totalReferenceEdges} references`,
      },
      {
        label: "Updated",
        value: knowledge.stats.latestDate || "--",
        hint: knowledge.stats.generatedAt ? "generated index" : "content date",
      },
    ];

    summary.innerHTML = cards
      .map(
        (card) => `
          <article class="summary-card">
            <span class="summary-label">${escapeHtml(card.label)}</span>
            <strong class="summary-value">${escapeHtml(String(card.value))}</strong>
            <span class="summary-hint">${escapeHtml(card.hint)}</span>
          </article>
        `,
      )
      .join("");
  }

  function renderQuickActions(filtered) {
    if (!actions) {
      return;
    }

    const latestNote = filtered
      .slice()
      .sort((a, b) => b.dateValue - a.dateValue || collator.compare(a.title, b.title))[0];
    const randomPool = filtered.length > 0 ? filtered : selectableNotes;
    const randomNote = randomPool[Math.floor(Math.random() * randomPool.length)] || null;
    const focusNote = state.focusedKey ? knowledge.byKey.get(state.focusedKey) : null;
    const visibleTagCounts = new Map();

    filtered.forEach((note) => {
      note.tags.forEach((tag) => {
        visibleTagCounts.set(tag, (visibleTagCounts.get(tag) || 0) + 1);
      });
    });

    const topTags = Array.from(visibleTagCounts.entries())
      .sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0]))
      .slice(0, 3);

    actions.innerHTML = `
      <div class="quick-action-group">
        <button type="button" class="quick-action-btn" data-action="random-note">Open Random</button>
        <button type="button" class="quick-action-btn" data-action="latest-note" ${latestNote ? "" : "disabled"}>Open Latest</button>
        <button type="button" class="quick-action-btn" data-action="copy-view">Copy Link</button>
      </div>
      <div class="quick-action-status">
        ${
          focusNote
            ? `<span class="quick-action-hint">Focused note: ${escapeHtml(focusNote.title)}</span>`
            : latestNote
              ? `<span class="quick-action-hint">Latest visible note: ${escapeHtml(latestNote.title)}</span>`
              : `<span class="quick-action-hint">Use search, topic filters, or graph focus to narrow the archive.</span>`
        }
        <span class="quick-action-shortcuts">Keys: <kbd>/</kbd> search, <kbd>R</kbd> random</span>
        ${
          topTags.length > 0
            ? `<span class="quick-action-tags">Common topics: ${topTags.map(([tag, count]) => `<button type="button" class="quick-inline-tag" data-quick-tag="${escapeHtml(tag)}">#${escapeHtml(tag)} · ${count}</button>`).join("")}</span>`
            : ""
        }
      </div>
    `;

    actions.querySelector('[data-action="random-note"]')?.addEventListener("click", () => {
      if (randomNote) {
        window.location.href = randomNote.link;
      }
    });

    actions.querySelector('[data-action="latest-note"]')?.addEventListener("click", () => {
      if (latestNote) {
        window.location.href = latestNote.link;
      }
    });

    actions.querySelector('[data-action="copy-view"]')?.addEventListener("click", () => {
      const url = window.location.href;
      const button = actions.querySelector('[data-action="copy-view"]');
      const original = button ? button.textContent : "";

      navigator.clipboard?.writeText(url).then(() => {
        if (button) {
          button.textContent = "Copied";
          window.setTimeout(() => {
            button.textContent = original;
          }, 1200);
        }
      }).catch(() => {});
    });

    actions.querySelectorAll("[data-quick-tag]").forEach((button) => {
      button.addEventListener("click", () => {
        const tag = button.dataset.quickTag || "";
        if (tag) {
          state.tags.add(tag);
          render();
        }
      });
    });
  }

  function renderActiveFilters(filtered) {
    if (!activeFilters) {
      return;
    }

    const chips = [];
    const groupCount = new Set(filtered.map((note) => note.groupKey)).size;

    if (state.text) {
      chips.push(`
        <button class="filter-chip" type="button" data-filter-kind="text">
          Search: ${escapeHtml(state.text)}
        </button>
      `);
    }

    Array.from(state.tags)
      .sort((a, b) => collator.compare(a, b))
      .forEach((tag) => {
        chips.push(`
          <button class="filter-chip" type="button" data-filter-kind="tag" data-tag="${escapeHtml(tag)}">
            #${escapeHtml(tag)}
          </button>
        `);
      });

    activeFilters.innerHTML =
      chips.length > 0
        ? `
          <div class="active-filter-bar">
            <span class="active-filter-stats">${filtered.length} notes across ${groupCount} sections</span>
            <div class="active-filter-list">
              ${chips.join("")}
              <button class="filter-chip filter-chip-clear" type="button" data-filter-kind="clear-all">Clear filters</button>
            </div>
          </div>
        `
        : `<div class="active-filter-empty">${filtered.length} notes available.</div>`;

    activeFilters.querySelectorAll("[data-filter-kind='tag']").forEach((button) => {
      button.addEventListener("click", () => {
        state.tags.delete(button.dataset.tag || "");
        render();
      });
    });

    const textChip = activeFilters.querySelector("[data-filter-kind='text']");
    if (textChip) {
      textChip.addEventListener("click", () => {
        state.text = "";
        searchInput.value = "";
        render();
      });
    }

    const clearAllChip = activeFilters.querySelector("[data-filter-kind='clear-all']");
    if (clearAllChip) {
      clearAllChip.addEventListener("click", () => {
        state.text = "";
        state.tags.clear();
        state.focusedKey = "";
        searchInput.value = "";
        render();
      });
    }
  }

  function renderTags(filtered) {
    const visibleTagCounts = new Map();

    filtered.forEach((file) => {
      file.tags.forEach((tag) => {
        visibleTagCounts.set(tag, (visibleTagCounts.get(tag) || 0) + 1);
      });
    });

    const orderedTags = selectableTags
      .slice()
      .sort((a, b) => {
        const aActive = state.tags.has(a.name) ? 1 : 0;
        const bActive = state.tags.has(b.name) ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;

        const aVisible = visibleTagCounts.get(a.name) || 0;
        const bVisible = visibleTagCounts.get(b.name) || 0;
        if (aVisible !== bVisible) return bVisible - aVisible;

        if (a.count !== b.count) return b.count - a.count;
        return collator.compare(a.name, b.name);
      })
      .filter((tag) => state.tags.has(tag.name) || !state.text || (visibleTagCounts.get(tag.name) || 0) > 0);

    tagCloud.innerHTML = orderedTags
      .map((tag) => {
        const isActive = state.tags.has(tag.name);
        const visibleCount = visibleTagCounts.get(tag.name) || 0;
        const muted = !isActive && visibleCount === 0 && (state.text || state.tags.size > 0);

        return `
          <button
            type="button"
            class="tag-chip ${isActive ? "active" : ""} ${muted ? "muted" : ""}"
            data-tag="${escapeHtml(tag.name)}"
            aria-pressed="${isActive ? "true" : "false"}"
          >
            <span>#${escapeHtml(tag.name)}</span>
            <span class="tag-chip-count">${visibleCount || tag.count}</span>
          </button>
        `;
      })
      .join("");

    tagCloud.querySelectorAll(".tag-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const tag = chip.dataset.tag || "";
        if (state.tags.has(tag)) {
          state.tags.delete(tag);
        } else {
          state.tags.add(tag);
        }
        render();
      });
    });
  }

  function renderTabs(filesToRender) {
    app.innerHTML = "";

    if (filesToRender.length === 0) {
      app.innerHTML = `
        <div class="empty-state">
          <p>No notes match the current filter.</p>
          <button type="button" class="empty-state-action">Clear filters</button>
        </div>
      `;

      app.querySelector(".empty-state-action").addEventListener("click", () => {
        state.text = "";
        state.tags.clear();
        state.focusedKey = "";
        searchInput.value = "";
        render();
      });
      return;
    }

    const grouped = new Map();
    filesToRender.forEach((file) => {
      if (!grouped.has(file.groupKey)) {
        grouped.set(file.groupKey, []);
      }
      grouped.get(file.groupKey).push(file);
    });

    const groups = selectableGroups
      .filter((group) => grouped.has(group.key))
      .slice()
      .sort((a, b) => grouped.get(b.key).length - grouped.get(a.key).length || collator.compare(a.label, b.label));
    const btnContainer = document.createElement("div");
    btnContainer.className = "tab-buttons";
    const contentContainer = document.createElement("div");
    contentContainer.className = "tab-contents";

    app.appendChild(btnContainer);
    app.appendChild(contentContainer);

    if (!state.tab || !grouped.has(state.tab)) {
      state.tab = groups[0].key;
    }

    groups.forEach((group) => {
      const groupLabel = formatGroupLabel(group);
      const button = document.createElement("button");
      button.type = "button";
      button.className = `tab-btn ${group.key === state.tab ? "active" : ""}`;
      button.dataset.tab = group.key;
      button.innerHTML = `
        <span class="tab-btn-label">${escapeHtml(groupLabel)}</span>
        <span class="badge">${grouped.get(group.key).length}</span>
      `;
      applyTabButtonStyles(button, group.key === state.tab);
      button.addEventListener("click", () => {
        switchTab(group.key);
        syncUrlState();
      });
      btnContainer.appendChild(button);

      const pane = document.createElement("div");
      pane.className = `tab-content ${group.key === state.tab ? "active" : ""}`;
      pane.dataset.tab = group.key;

      const list = document.createElement("ul");
      list.className = "file-list";

      sortFiles(grouped.get(group.key)).forEach((file) => {
        const item = document.createElement("li");
        item.dataset.noteKey = file.key;
        item.className = state.focusedKey === file.key ? "is-focused" : "";

        const titleHtml = state.text ? applyHighlights(file.title, state.text) : escapeHtml(file.title);
        const summaryHtml = state.text
          ? applyHighlights(file.summary || "No summary yet.", state.text)
          : escapeHtml(file.summary || "No summary yet.");

        const tagHtml = file.tags
          .map(
            (tag) => `
              <button type="button" class="tag-small ${state.tags.has(tag) ? "highlight" : ""}" data-inline-tag="${escapeHtml(tag)}">
                #${escapeHtml(tag)}
              </button>
            `,
          )
          .join("");

        item.innerHTML = `
          <article class="file-card">
            <div class="file-card-main">
              <div class="file-row">
                <a href="${escapeHtml(file.link)}" class="file-link">${titleHtml}</a>
                <span class="file-date">${escapeHtml(file.date || "--")}</span>
              </div>
              <p class="file-summary">${summaryHtml}</p>
              <div class="file-meta">
                <span class="group-pill">${escapeHtml(file.groupLabel)}</span>
                <span class="relation-pill">${file.refs.length} refs</span>
                <span class="relation-pill">${file.backlinks.length} backlinks</span>
              </div>
            </div>
            <div class="file-tags">${tagHtml}</div>
          </article>
        `;

        item.querySelectorAll("[data-inline-tag]").forEach((tagButton) => {
          tagButton.addEventListener("click", () => {
            state.tags.add((tagButton.dataset.inlineTag || "").toLowerCase());
            render();
          });
        });

        list.appendChild(item);
      });

      pane.appendChild(list);
      contentContainer.appendChild(pane);
    });
  }

  function showSuggestions(query) {
    const trimmed = query.trim().toLowerCase();
    suggestionBox.innerHTML = "";
    activeSuggestionIndex = -1;

    if (!trimmed) {
      closeSuggestions();
      return;
    }

    const matchedTags = selectableTags
      .filter((tag) => tag.name.includes(trimmed))
      .slice(0, 6);

    const matchedNotes = (knowledge.filterNotes
      ? knowledge.filterNotes({ text: trimmed })
      : selectableNotes.filter((note) => note.title.toLowerCase().includes(trimmed)))
      .slice(0, 6);

    if (matchedTags.length === 0 && matchedNotes.length === 0) {
      closeSuggestions();
      return;
    }

    let suggestionIndex = 0;

    matchedTags.forEach((tag) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "suggestion-item tag-suggestion";
      option.id = `note-search-suggestion-${suggestionIndex}`;
      option.dataset.suggestionIndex = String(suggestionIndex);
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      option.innerHTML = `<span>#${escapeHtml(tag.name)}</span><span>${tag.count}</span>`;
      option.addEventListener("click", () => {
        state.tags.add(tag.name);
        state.text = "";
        searchInput.value = "";
        closeSuggestions();
        render();
      });
      suggestionBox.appendChild(option);
      suggestionIndex += 1;
    });

    if (matchedTags.length > 0 && matchedNotes.length > 0) {
      const divider = document.createElement("div");
      divider.className = "suggestion-divider";
      divider.textContent = "Notes";
      suggestionBox.appendChild(divider);
    }

    matchedNotes.forEach((note) => {
      const option = document.createElement("a");
      option.className = "suggestion-item note-suggestion";
      option.id = `note-search-suggestion-${suggestionIndex}`;
      option.dataset.suggestionIndex = String(suggestionIndex);
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      option.href = note.link;
      option.innerHTML = `<span>${escapeHtml(note.title)}</span><span>${escapeHtml(note.groupLabel)}</span>`;
      option.addEventListener("click", () => {
        closeSuggestions();
      });
      suggestionBox.appendChild(option);
      suggestionIndex += 1;
    });

    openSuggestions();
  }

  function emitState(filtered) {
    const visibleKeys = new Set(filtered.map((file) => file.key));
    knowledge.notes
      .filter((note) => note.hidden)
      .forEach((note) => visibleKeys.add(note.key));

    document.dispatchEvent(
      new CustomEvent("knowledge:filters-changed", {
        detail: {
          text: state.text,
          tags: Array.from(state.tags),
          visibleKeys: Array.from(visibleKeys),
          focusedKey: state.focusedKey,
        },
      }),
    );
  }

  function scrollFocusedNoteIntoView() {
    if (!pendingScrollKey) {
      return;
    }

    const target = document.querySelector(`[data-note-key="${CSS.escape(pendingScrollKey)}"]`);
    if (target) {
      target.scrollIntoView({ block: "center", behavior: "smooth" });
    }

    pendingScrollKey = "";
  }

  function render() {
    const filtered = filterFiles();

    if (state.focusedKey && !filtered.some((file) => file.key === state.focusedKey)) {
      state.focusedKey = "";
    }

    renderAcademicPanels();
    renderSummary(filtered);
    renderQuickActions(filtered);
    renderActiveFilters(filtered);
    renderTags(filtered);
    renderTabs(filtered);

    resetBtn.style.display = state.text || state.tags.size > 0 ? "block" : "none";
    if (!state.text) {
      closeSuggestions();
    }

    syncUrlState();
    emitState(filtered);
    scrollFocusedNoteIntoView();
  }

  const handleSearchInput = debounce((value) => {
    state.text = value.trim();
    state.focusedKey = "";
    showSuggestions(value);
    render();
  }, 150);

  searchInput.addEventListener("compositionstart", () => {
    isComposing = true;
  });

  searchInput.addEventListener("compositionend", (event) => {
    isComposing = false;
    handleSearchInput(event.target.value);
  });

  searchInput.addEventListener("input", (event) => {
    if (isComposing) {
      return;
    }
    handleSearchInput(event.target.value);
  });

  searchInput.addEventListener("keydown", (event) => {
    const items = suggestionItems();

    if (event.key === "ArrowDown" && items.length > 0) {
      event.preventDefault();
      setActiveSuggestion(activeSuggestionIndex + 1);
      return;
    }

    if (event.key === "ArrowUp" && items.length > 0) {
      event.preventDefault();
      setActiveSuggestion(activeSuggestionIndex - 1);
      return;
    }

    if (event.key === "Enter" && activeSuggestionIndex >= 0 && items[activeSuggestionIndex]) {
      event.preventDefault();
      items[activeSuggestionIndex].click();
      return;
    }

    if (event.key === "Escape") {
      closeSuggestions();
      searchInput.blur();
    }
  });

  document.addEventListener("keydown", (event) => {
    const tagName = (event.target && event.target.tagName) || "";
    const isTypingTarget = ["INPUT", "TEXTAREA", "SELECT"].includes(tagName) || event.target?.isContentEditable;

    if (event.key === "/" && !isTypingTarget) {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
      return;
    }

    if ((event.key === "r" || event.key === "R") && !isTypingTarget) {
      const pool = knowledge.filterNotes({ text: state.text, tags: Array.from(state.tags) });
      const randomSource = pool.length > 0 ? pool : selectableNotes;
      const randomNote = randomSource[Math.floor(Math.random() * randomSource.length)];
      if (randomNote) {
        window.location.href = randomNote.link;
      }
    }
  });

  searchInput.addEventListener("focus", () => {
    if (searchInput.value.trim()) {
      showSuggestions(searchInput.value);
    }
  });

  document.addEventListener("click", (event) => {
    if (!searchWrapper.contains(event.target)) {
      closeSuggestions();
    }
  });

  resetBtn.addEventListener("click", () => {
    state.text = "";
    state.tags.clear();
    state.focusedKey = "";
    searchInput.value = "";
    render();
  });

  sortSelect.addEventListener("change", (event) => {
    state.sort = event.target.value;
    render();
  });

  window.addEventListener("popstate", () => {
    readUrlState();
    render();
  });

  document.addEventListener("knowledge:apply-tag", (event) => {
    const tag = String(event.detail && event.detail.tag ? event.detail.tag : "").toLowerCase();
    if (!tag) {
      return;
    }

    state.tags.add(tag);
    state.text = "";
    searchInput.value = "";
    render();
  });

  document.addEventListener("knowledge:focus-note", (event) => {
    const key = event.detail && event.detail.key;
    const note = key ? knowledge.byKey.get(key) : null;
    if (!note || note.hidden) {
      return;
    }

    state.tab = note.groupKey;
    state.focusedKey = note.key;
    pendingScrollKey = note.key;
    render();
  });

  readUrlState();
  render();
});
