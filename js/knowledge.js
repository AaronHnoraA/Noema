(function () {
  function titleize(segment) {
    if (!segment || segment === "Root") {
      return "Root";
    }

    if (/^[A-Z0-9-]+$/.test(segment)) {
      return segment;
    }

    return segment
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  function normalizeTag(tag) {
    return String(tag || "").trim().toLowerCase();
  }

  function normalizeList(values, { lower = false } = {}) {
    return Array.from(
      new Set(
        (Array.isArray(values) ? values : [])
          .map((value) => String(value || "").trim())
          .filter(Boolean)
          .map((value) => (lower ? value.toLowerCase() : value)),
      ),
    );
  }

  function inferGroupLabel(groupKey) {
    if (!groupKey || groupKey === "Root") {
      return "Root";
    }

    const parts = String(groupKey).split("/").filter(Boolean);
    return titleize(parts[parts.length - 1] || groupKey);
  }

  function flattenLegacyData(raw) {
    return Object.entries(raw || {}).flatMap(([groupKey, items]) =>
      (Array.isArray(items) ? items : []).map((item) => ({
        ...item,
        groupKey,
        groupLabel: inferGroupLabel(groupKey),
        key: item.id || item.link || `${groupKey}:${item.title}`,
        refs: [],
        backlinks: [],
        summary: item.desc || "",
      })),
    );
  }

  function normalizeNote(note) {
    const groupKey = note.groupKey || note.folder || "Root";
    const tags = Array.from(
      new Set((Array.isArray(note.tags) ? note.tags : []).map(normalizeTag).filter(Boolean)),
    ).sort((a, b) => a.localeCompare(b));
    const aliases = normalizeList(note.aliases);
    const path = String(note.path || note.relPath || note.sourcePath || note.link || "");
    const searchText = String(note.searchText || note.body || note.content || "").trim();

    return {
      key: note.key || note.id || note.link || `${groupKey}:${note.title}`,
      id: note.id || null,
      title: String(note.title || "Untitled"),
      link: String(note.link || "#"),
      path,
      date: String(note.date || ""),
      dateValue: Date.parse(note.date || "") || 0,
      summary: String(note.summary || note.desc || "").trim(),
      searchText,
      groupKey,
      groupLabel: inferGroupLabel(note.groupLabel || groupKey),
      section: note.section || (groupKey.includes("/") ? groupKey.split("/")[0] : groupKey),
      hidden: Boolean(note.hidden),
      tags,
      aliases,
      refs: Array.from(new Set(Array.isArray(note.refs) ? note.refs.filter(Boolean) : [])),
      backlinks: Array.from(new Set(Array.isArray(note.backlinks) ? note.backlinks.filter(Boolean) : [])),
    };
  }

  function normalizeText(value) {
    return String(value || "").toLowerCase();
  }

  function unquoteQueryValue(value) {
    const text = String(value || "");
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
      return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    return text;
  }

  function tokenizeQuery(text) {
    const tokens = [];
    const pattern = /(#"(?:\\.|[^"\\])*")|([a-zA-Z]+:"(?:\\.|[^"\\])*")|("(?:\\.|[^"\\])*")|(\S+)/g;
    let match;

    while ((match = pattern.exec(String(text || "")))) {
      if (match[1] !== undefined) {
        tokens.push(match[1]);
      } else if (match[2] !== undefined) {
        tokens.push(match[2]);
      } else if (match[3] !== undefined) {
        tokens.push(unquoteQueryValue(match[3]));
      } else {
        tokens.push(match[4]);
      }
    }

    return tokens.map((token) => token.trim()).filter(Boolean);
  }

  function parseSearchQuery(text) {
    const parsed = {
      terms: [],
      tags: [],
      aliases: [],
      paths: [],
      titles: [],
      groups: [],
      sections: [],
    };

    tokenizeQuery(text).forEach((token) => {
      if (token.startsWith("#") && token.length > 1) {
        parsed.tags.push(normalizeTag(unquoteQueryValue(token.slice(1))));
        return;
      }

      const fieldMatch = token.match(/^([a-zA-Z]+):(.*)$/);
      if (!fieldMatch) {
        parsed.terms.push(normalizeText(token));
        return;
      }

      const field = fieldMatch[1].toLowerCase();
      const value = normalizeText(unquoteQueryValue(fieldMatch[2]));

      if (!value) {
        return;
      }

      if (field === "tag" || field === "tags") parsed.tags.push(value);
      else if (field === "alias" || field === "aliases" || field === "aka") parsed.aliases.push(value);
      else if (field === "path" || field === "file") parsed.paths.push(value);
      else if (field === "title") parsed.titles.push(value);
      else if (field === "group" || field === "folder") parsed.groups.push(value);
      else if (field === "section") parsed.sections.push(value);
      else parsed.terms.push(normalizeText(token));
    });

    Object.keys(parsed).forEach((key) => {
      parsed[key] = Array.from(new Set(parsed[key]));
    });

    return parsed;
  }

  function includesAll(haystack, needles) {
    return needles.length === 0 || needles.every((needle) => haystack.includes(needle));
  }

  function listMatchesAll(values, needles) {
    const normalized = values.map(normalizeText);
    return needles.length === 0 || needles.every((needle) =>
      normalized.some((value) => value === needle || value.includes(needle)),
    );
  }

  function buildCollections(noteList) {
    const groupMap = new Map();
    const tagMap = new Map();
    let latestDate = "";
    let totalReferenceEdges = 0;

    noteList.forEach((note) => {
      if (!groupMap.has(note.groupKey)) {
        groupMap.set(note.groupKey, []);
      }
      groupMap.get(note.groupKey).push(note);

      note.tags.forEach((tag) => {
        if (!tagMap.has(tag)) {
          tagMap.set(tag, { name: tag, count: 0, notes: [] });
        }

        const entry = tagMap.get(tag);
        entry.count += 1;
        entry.notes.push(note.key);
      });

      totalReferenceEdges += note.refs.length;

      if (note.date && (!latestDate || note.date > latestDate)) {
        latestDate = note.date;
      }
    });

    const groups = Array.from(groupMap.entries())
      .map(([key, items]) => ({
        key,
        label: inferGroupLabel(key),
        items: items.slice().sort((a, b) => b.dateValue - a.dateValue || a.title.localeCompare(b.title)),
      }))
      .sort((a, b) => {
        if (a.key === "Root") return -1;
        if (b.key === "Root") return 1;
        return a.label.localeCompare(b.label);
      });

    const tags = Array.from(tagMap.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const connectedNotes = noteList.filter((note) => note.refs.length > 0 || note.backlinks.length > 0).length;

    return {
      groups,
      tags,
      latestDate,
      totalReferenceEdges,
      connectedNotes,
    };
  }

  function buildKnowledgeData() {
    if (typeof SITE_DATA === "undefined") {
      window.KNOWLEDGE_DATA = null;
      return;
    }

    const rawNotes = Array.isArray(SITE_DATA.notes) ? SITE_DATA.notes : flattenLegacyData(SITE_DATA);
    const notes = rawNotes.map(normalizeNote);
    const byKey = new Map(notes.map((note) => [note.key, note]));

    notes.forEach((note) => {
      note.refs = note.refs.filter((key) => byKey.has(key) && key !== note.key);
      note.backlinks = note.backlinks.filter((key) => byKey.has(key) && key !== note.key);
      note.searchBlob = normalizeText(
        [
          note.title,
          note.summary,
          note.searchText,
          note.path,
          note.groupKey,
          note.groupLabel,
          note.section,
          ...note.tags,
          ...note.aliases,
        ].join(" "),
      );
    });

    const publicNotes = notes.filter((note) => !note.hidden);
    const allCollections = buildCollections(notes);
    const publicCollections = buildCollections(publicNotes);

    window.KNOWLEDGE_DATA = {
      raw: SITE_DATA,
      notes,
      publicNotes,
      byKey,
      groups: allCollections.groups,
      tags: allCollections.tags,
      publicGroups: publicCollections.groups,
      publicTags: publicCollections.tags,
      stats: {
        totalNotes: publicNotes.length,
        totalAllNotes: notes.length,
        hiddenNotes: notes.length - publicNotes.length,
        totalTags: publicCollections.tags.length,
        totalAllTags: allCollections.tags.length,
        connectedNotes: publicCollections.connectedNotes,
        totalReferenceEdges: publicCollections.totalReferenceEdges,
        graphReferenceEdges: allCollections.totalReferenceEdges,
        latestDate: publicCollections.latestDate || (SITE_DATA.meta && SITE_DATA.meta.generatedAt) || "",
        generatedAt: (SITE_DATA.meta && SITE_DATA.meta.generatedAt) || "",
      },
      filterNotes({ text = "", tags: activeTags = [], includeHidden = false } = {}) {
        const query = parseSearchQuery(text);
        const requiredTags = Array.from(new Set([
          ...Array.from(activeTags).map(normalizeTag).filter(Boolean),
          ...query.tags,
        ]));
        const source = includeHidden ? notes : publicNotes;

        return source.filter((note) => {
          const matchesText =
            includesAll(note.searchBlob, query.terms);
          const matchesTags =
            requiredTags.length === 0 || requiredTags.every((tag) => note.tags.includes(tag));
          const matchesAliases = listMatchesAll(note.aliases, query.aliases);
          const matchesPath = includesAll(normalizeText(note.path), query.paths);
          const matchesTitle = includesAll(normalizeText(note.title), query.titles);
          const matchesGroup = includesAll(normalizeText(`${note.groupKey} ${note.groupLabel}`), query.groups);
          const matchesSection = includesAll(normalizeText(note.section), query.sections);

          return matchesText
            && matchesTags
            && matchesAliases
            && matchesPath
            && matchesTitle
            && matchesGroup
            && matchesSection;
        });
      },
      parseSearchQuery,
      scoreNote(note, text = "", tags = []) {
        const query = parseSearchQuery(text);
        const freeTerms = query.terms;
        let score = 0;

        freeTerms.forEach((term) => {
          if (normalizeText(note.title).includes(term)) score += 8;
          if (note.aliases.some((alias) => normalizeText(alias).includes(term))) score += 7;
          if (note.tags.some((tag) => tag.includes(term))) score += 5;
          if (normalizeText(note.summary).includes(term)) score += 3;
          if (normalizeText(note.path).includes(term)) score += 2;
          if (normalizeText(note.searchText).includes(term)) score += 1;
        });

        Array.from(tags).map(normalizeTag).forEach((tag) => {
          if (note.tags.includes(tag)) score += 4;
        });

        return score;
      },
      inferGroupLabel,
    };
  }

  window.buildKnowledgeData = buildKnowledgeData;
  buildKnowledgeData();
})();
