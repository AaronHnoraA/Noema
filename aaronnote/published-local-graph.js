const STORAGE_KEY = "aaronnote-published-local-graph-collapsed";
const MAX_NODES = 72;
const MAX_LINKS = 160;

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function noteUnderRoam(note) {
  return [note?.path, note?.link, note?.groupKey]
    .map(normalizePath)
    .some((path) => path === "roam" || path.startsWith("roam/"));
}

function noteKey(note) {
  return note?.key || note?.id || note?.path || note?.link || note?.title || "";
}

function noteTitle(note) {
  return note?.title || note?.id || note?.path || note?.link || "Untitled";
}

function unique(items, key) {
  const seen = new Set();
  const out = [];
  items.forEach((item) => {
    const value = key(item);
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push(item);
  });
  return out;
}

function scriptRoot() {
  const moduleUrl = import.meta.url || "";
  const script = document.currentScript;
  const src = script instanceof HTMLScriptElement ? script.src : "";
  const marker = "Noema/aaronnote/published-local-graph.js";
  const source = moduleUrl || src;
  const index = source.indexOf(marker);
  return index >= 0 ? source.slice(0, index) : "./";
}

function loadScript(src) {
  const existing = document.querySelector(`script[src="${src}"]`);
  if (existing?.dataset.loaded === "true") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = existing || document.createElement("script");
    script.src = src;
    script.defer = false;
    script.addEventListener("load", () => {
      script.dataset.loaded = "true";
      resolve();
    }, { once: true });
    script.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), { once: true });
    if (!existing) document.head.appendChild(script);
  });
}

function normalizeLookup(value) {
  return String(value || "")
    .trim()
    .replace(/^#/, "")
    .replace(/\\/g, "/")
    .replace(/\.md$/i, "")
    .replace(/\.html$/i, "")
    .toLowerCase();
}

function nodeIdentifiers(note) {
  return [
    note?.key,
    note?.id,
    note?.title,
    note?.path,
    note?.link,
    ...(note?.aliases || []),
  ].map((value) => String(value || "").trim()).filter(Boolean);
}

function buildLookup(notes) {
  const lookup = new Map();
  notes.forEach((note) => {
    nodeIdentifiers(note).forEach((id) => {
      const key = normalizeLookup(id);
      if (key && !lookup.has(key)) lookup.set(key, note);
    });
  });
  return lookup;
}

function resolveRef(ref, lookup) {
  return lookup.get(normalizeLookup(ref));
}

function currentPageNote(notes) {
  const path = decodeURIComponent(window.location.pathname).replace(/\\/g, "/");
  return notes.find((note) => {
    const link = normalizePath(note.link);
    return link && (path.endsWith(`/${link}`) || path.endsWith(link));
  }) || null;
}

function noteTags(note) {
  return unique([...(note?.tags || []), ...(note?.inlineTags || [])]
    .map((tag) => String(tag || "").trim().replace(/^#/, ""))
    .filter(Boolean), (tag) => tag.toLowerCase());
}

function seededPosition(index, depth, width, height) {
  if (depth === 0) return { x: width / 2, y: height / 2 };
  const radius = Math.min(width, height) * (depth === 1 ? 0.27 : 0.41);
  const angle = index * 2.399963229728653 + depth * 0.7;
  return {
    x: width / 2 + Math.cos(angle) * radius,
    y: height / 2 + Math.sin(angle) * radius,
  };
}

function fitLabel(label) {
  const text = String(label || "").trim();
  return text.length <= 22 ? text : `${text.slice(0, 21)}…`;
}

function createNodeElement(svg, node, siteRoot) {
  const group = document.createElementNS(svg.namespaceURI, "g");
  group.classList.add("aaronnote-local-graph-node", `is-${node.type}`, `depth-${Math.min(2, node.depth)}`);
  group.setAttribute("role", "button");
  group.setAttribute("tabindex", "0");
  group.setAttribute("aria-label", node.label);
  const circle = document.createElementNS(svg.namespaceURI, "circle");
  circle.setAttribute("r", node.type === "current" ? "9" : node.type === "tag" ? "5.5" : "7");
  const text = document.createElementNS(svg.namespaceURI, "text");
  text.textContent = fitLabel(node.label);
  text.setAttribute("y", node.type === "tag" ? "17" : "20");
  group.append(circle, text);
  group.addEventListener("click", () => {
    if (node.type === "tag") {
      window.location.href = `${siteRoot}notes.html?tags=${encodeURIComponent(node.tag)}#notes-section`;
      return;
    }
    if (node.note?.link) window.location.href = `${siteRoot}${node.note.link}`;
  });
  return group;
}

function initPublishedLocalGraph() {
  const root = document.querySelector("[data-published-local-graph]");
  if (!(root instanceof HTMLElement)) return;
  const likelyRoamPage = normalizePath(window.location.pathname).includes("/roam/");
  if (!likelyRoamPage) return;

  const siteRoot = scriptRoot();
  let knowledgePromise = null;
  let currentNote = null;
  let notes = [];
  let renderKey = "";
  let animationFrame = 0;

  // DOM refs — set from existing HTML (old mode) or created on demand (new mode)
  let canvas, depthInput, depthLabel, refsInput, backlinksInput, tagsInput, status;
  // In new (MacWindow) mode "collapsed" is a plain boolean — no class toggling on root
  let _newModeCollapsed = true;
  const openBtn = root.querySelector("[data-local-graph-open]");

  function collapsed() {
    return openBtn ? _newModeCollapsed : root.classList.contains("is-collapsed");
  }

  function clearGraph() {
    window.cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    canvas?.replaceChildren();
  }

  function setCollapsed(value) {
    if (openBtn) {
      _newModeCollapsed = value;
    } else {
      root.classList.toggle("is-collapsed", value);
      if (depthInput) root.querySelector("[data-local-graph-toggle]")?.setAttribute("aria-expanded", value ? "false" : "true");
      window.localStorage?.setItem(STORAGE_KEY, String(value));
    }
    if (value) clearGraph();
  }

  async function ensureKnowledge() {
    if (!knowledgePromise) {
      knowledgePromise = (async () => {
        if (!window.KNOWLEDGE_DATA) {
          await loadScript(`${siteRoot}js/data.js`);
          await loadScript(`${siteRoot}js/knowledge.js`);
          window.buildKnowledgeData?.();
        }
        const knowledge = window.KNOWLEDGE_DATA;
        notes = (knowledge?.publicNotes || knowledge?.notes || []).filter((note) => !note.hidden && !note.private);
        currentNote = currentPageNote(notes);
        if (!currentNote || !noteUnderRoam(currentNote)) {
          root.hidden = true;
          return false;
        }
        return true;
      })();
    }
    return knowledgePromise;
  }

  function settings() {
    return {
      depth: Math.max(1, Math.min(2, Number(depthInput?.value) || 1)),
      refs: depthInput ? (refsInput?.checked ?? true) : true,
      backlinks: depthInput ? (backlinksInput?.checked ?? true) : true,
      tags: depthInput ? (tagsInput?.checked ?? true) : true,
    };
  }

  function buildGraph(width, height) {
    const config = settings();
    const lookup = buildLookup(notes);
    const currentKey = noteKey(currentNote);
    const outgoing = new Map();
    const incoming = new Map();
    const tagsByNote = new Map();
    notes.forEach((note) => {
      const key = noteKey(note);
      if (!key) return;
      outgoing.set(key, unique((note.refs || [])
        .map((ref) => resolveRef(ref, lookup))
        .filter((target) => target && noteKey(target) !== key), noteKey));
      tagsByNote.set(key, noteTags(note));
    });
    notes.forEach((note) => {
      const key = noteKey(note);
      if (!key) return;
      (outgoing.get(key) || []).forEach((target) => {
        const targetKey = noteKey(target);
        const list = incoming.get(targetKey) || [];
        list.push(note);
        incoming.set(targetKey, unique(list, noteKey));
      });
      (note.backlinks || []).forEach((ref) => {
        const source = resolveRef(ref, lookup);
        if (!source || noteKey(source) === key) return;
        const list = incoming.get(key) || [];
        list.push(source);
        incoming.set(key, unique(list, noteKey));
      });
    });

    const nodes = new Map();
    const links = new Map();
    let index = 0;
    let truncated = false;

    function addNode(node) {
      if (nodes.has(node.id)) {
        nodes.get(node.id).depth = Math.min(nodes.get(node.id).depth, node.depth);
        return true;
      }
      if (nodes.size >= MAX_NODES) {
        truncated = true;
        return false;
      }
      const pos = seededPosition(index, node.depth, width, height);
      index += 1;
      nodes.set(node.id, { ...node, ...pos, vx: 0, vy: 0 });
      return true;
    }

    function addNote(note, depth, type = "note") {
      const id = noteKey(note);
      return id && addNode({ id, type, depth, label: noteTitle(note), note });
    }

    function addTag(tag, depth) {
      const clean = String(tag || "").trim().replace(/^#/, "");
      return clean && addNode({ id: `tag:${clean.toLowerCase()}`, type: "tag", depth, label: `#${clean}`, tag: clean });
    }

    function addLink(source, target, type) {
      if (!source || !target || source === target) return;
      if (links.size >= MAX_LINKS) {
        truncated = true;
        return;
      }
      const id = `${source}\n${target}\n${type}`;
      if (!links.has(id)) links.set(id, { id, source, target, type });
    }

    addNote(currentNote, 0, "current");
    const queue = [{ note: currentNote, depth: 0 }];
    const expanded = new Set();
    while (queue.length > 0) {
      const item = queue.shift();
      const key = noteKey(item.note);
      if (!key || expanded.has(`${key}:${item.depth}`) || item.depth >= config.depth) continue;
      expanded.add(`${key}:${item.depth}`);
      const nextDepth = item.depth + 1;
      if (config.refs) {
        (outgoing.get(key) || []).forEach((target) => {
          const targetKey = noteKey(target);
          if (!addNote(target, nextDepth) || !targetKey) return;
          addLink(key, targetKey, "ref");
          if (nextDepth < config.depth) queue.push({ note: target, depth: nextDepth });
        });
      }
      if (config.backlinks) {
        (incoming.get(key) || []).forEach((source) => {
          const sourceKey = noteKey(source);
          if (!addNote(source, nextDepth) || !sourceKey) return;
          addLink(sourceKey, key, "backlink");
          if (nextDepth < config.depth) queue.push({ note: source, depth: nextDepth });
        });
      }
      if (config.tags) {
        (tagsByNote.get(key) || []).forEach((tag) => {
          const tagId = `tag:${tag.toLowerCase()}`;
          if (!addTag(tag, nextDepth)) return;
          addLink(key, tagId, "tag");
        });
      }
    }
    return { nodes: [...nodes.values()], links: [...links.values()], truncated };
  }

  function render() {
    if (collapsed() || !currentNote) return;
    if (depthLabel && depthInput) depthLabel.textContent = depthInput.value;
    const key = [
      noteKey(currentNote),
      depthInput.value,
      refsInput.checked ? "refs" : "",
      backlinksInput.checked ? "backlinks" : "",
      tagsInput.checked ? "tags" : "",
      (currentNote.refs || []).join(","),
      (currentNote.backlinks || []).join(","),
      noteTags(currentNote).join(","),
    ].join("\n");
    if (key === renderKey) return;
    renderKey = key;
    clearGraph();

    const rect = canvas.getBoundingClientRect();
    const width = Math.max(300, Math.round(rect.width || canvas.clientWidth || 360));
    const height = Math.max(240, Math.round(rect.height || canvas.clientHeight || 260));
    const graph = buildGraph(width, height);
    if (graph.nodes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "aaronnote-local-graph-empty";
      empty.textContent = "No local graph";
      canvas.replaceChildren(empty);
      return;
    }

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.classList.add("aaronnote-local-graph-svg");
    const linkLayer = document.createElementNS(svg.namespaceURI, "g");
    const nodeLayer = document.createElementNS(svg.namespaceURI, "g");
    svg.append(linkLayer, nodeLayer);
    canvas.replaceChildren(svg);
    const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
    const linkEls = graph.links.map((link) => {
      const line = document.createElementNS(svg.namespaceURI, "line");
      line.classList.add("aaronnote-local-graph-link", `is-${link.type}`);
      line.setAttribute("stroke-linecap", "round");
      linkLayer.appendChild(line);
      return { link, line };
    });
    const nodeEls = graph.nodes.map((node) => {
      const group = createNodeElement(svg, node, siteRoot);
      nodeLayer.appendChild(group);
      return { node, group };
    });

    function applyPositions() {
      linkEls.forEach(({ link, line }) => {
        const source = nodeMap.get(link.source);
        const target = nodeMap.get(link.target);
        if (!source || !target) return;
        line.setAttribute("x1", String(source.x));
        line.setAttribute("y1", String(source.y));
        line.setAttribute("x2", String(target.x));
        line.setAttribute("y2", String(target.y));
      });
      nodeEls.forEach(({ node, group }) => {
        group.setAttribute("transform", `translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})`);
      });
    }

    let tick = 0;
    function step() {
      if (collapsed()) return;
      const alpha = Math.max(0.018, 0.13 * (1 - tick / 120));
      linkEls.forEach(({ link }) => {
        const source = nodeMap.get(link.source);
        const target = nodeMap.get(link.target);
        if (!source || !target) return;
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const desired = link.type === "tag" ? 64 : 92;
        const strength = (distance - desired) / distance * (link.type === "tag" ? 0.018 : 0.024) * alpha;
        source.vx += dx * strength;
        source.vy += dy * strength;
        target.vx -= dx * strength;
        target.vy -= dy * strength;
      });
      for (let i = 0; i < graph.nodes.length; i += 1) {
        const a = graph.nodes[i];
        for (let j = i + 1; j < graph.nodes.length; j += 1) {
          const b = graph.nodes[j];
          const dx = b.x - a.x || 0.01;
          const dy = b.y - a.y || 0.01;
          const distance = Math.max(12, Math.hypot(dx, dy));
          const strength = (a.type === "tag" || b.type === "tag" ? 44 : 66) / (distance * distance) * alpha;
          a.vx -= dx * strength;
          a.vy -= dy * strength;
          b.vx += dx * strength;
          b.vy += dy * strength;
        }
      }
      graph.nodes.forEach((node) => {
        const targetRadius = Math.min(width, height) * (node.depth === 0 ? 0 : node.depth === 1 ? 0.24 : 0.39);
        const dx = node.x - width / 2;
        const dy = node.y - height / 2;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const tx = width / 2 + dx / distance * targetRadius;
        const ty = height / 2 + dy / distance * targetRadius;
        node.vx += (tx - node.x) * 0.006 * alpha;
        node.vy += (ty - node.y) * 0.006 * alpha;
        if (node.type === "current") {
          node.vx += (width / 2 - node.x) * 0.03 * alpha;
          node.vy += (height / 2 - node.y) * 0.03 * alpha;
        }
        node.x = Math.max(18, Math.min(width - 18, node.x + node.vx));
        node.y = Math.max(20, Math.min(height - 26, node.y + node.vy));
        node.vx *= 0.82;
        node.vy *= 0.82;
      });
      applyPositions();
      tick += 1;
      if (tick < 140) animationFrame = window.requestAnimationFrame(step);
    }

    applyPositions();
    animationFrame = window.requestAnimationFrame(step);
    if (status) status.textContent = `${graph.nodes.length} nodes · ${graph.links.length} links${graph.truncated ? " · capped" : ""}`;
  }

  async function expandAndRender() {
    setCollapsed(false);
    if (status) status.textContent = "Loading";
    const ok = await ensureKnowledge();
    if (!ok) return;
    if (status) status.textContent = "";
    renderKey = "";
    render();
  }

  function wireControls() {
    [depthInput, refsInput, backlinksInput, tagsInput].forEach((input) => {
      input?.addEventListener("input", () => { renderKey = ""; render(); });
      input?.addEventListener("change", () => { renderKey = ""; render(); });
    });
    window.addEventListener("resize", () => {
      if (!collapsed()) { renderKey = ""; render(); }
    });
  }

  // ── New mode: floating MacWindow ─────────────────────────────────────────
  if (openBtn instanceof HTMLButtonElement) {
    let winHandle = null;
    openBtn.addEventListener("click", () => {
      if (winHandle) {
        /* Bring existing window to front */
        winHandle.el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        return;
      }
      if (!window.MacWindow) return;

      const controls = document.createElement("div");
      controls.className = "aaronnote-local-graph-controls";
      controls.innerHTML = `
        <label class="aaronnote-local-graph-depth">
          <span>Depth</span>
          <input data-local-graph-depth type="range" min="1" max="2" step="1" value="1" />
          <b data-local-graph-depth-label>1</b>
        </label>
        <label><input data-local-graph-refs type="checkbox" checked /> Refs</label>
        <label><input data-local-graph-backlinks type="checkbox" checked /> Backlinks</label>
        <label><input data-local-graph-tags type="checkbox" checked /> Tags</label>
        <span class="aaronnote-local-graph-status" data-local-graph-status></span>
      `;

      const graphCanvas = document.createElement("div");
      graphCanvas.className = "aaronnote-local-graph-canvas";
      graphCanvas.style.cssText = "flex:1;min-height:0;overflow:hidden;";

      winHandle = window.MacWindow.open({
        title: "Local Graph",
        width: 520,
        height: 420,
        onClose() {
          clearGraph();
          winHandle = null;
          depthInput = depthLabel = refsInput = backlinksInput = tagsInput = canvas = status = null;
          _newModeCollapsed = true;
          knowledgePromise = null; /* allow re-init on next open */
        },
        build(body) {
          body.style.display = "flex";
          body.style.flexDirection = "column";
          body.style.overflow = "hidden";
          body.appendChild(controls);
          body.appendChild(graphCanvas);

          depthInput  = controls.querySelector("[data-local-graph-depth]");
          depthLabel  = controls.querySelector("[data-local-graph-depth-label]");
          refsInput   = controls.querySelector("[data-local-graph-refs]");
          backlinksInput = controls.querySelector("[data-local-graph-backlinks]");
          tagsInput   = controls.querySelector("[data-local-graph-tags]");
          canvas      = graphCanvas;
          status      = controls.querySelector("[data-local-graph-status]");

          wireControls();
          setTimeout(() => void expandAndRender(), 50);
        },
      });
    });
    return;
  }

  // ── Old mode: aside panel toggle ─────────────────────────────────────────
  const toggle = root.querySelector("[data-local-graph-toggle]");
  depthInput = root.querySelector("[data-local-graph-depth]");
  depthLabel = root.querySelector("[data-local-graph-depth-label]");
  refsInput  = root.querySelector("[data-local-graph-refs]");
  backlinksInput = root.querySelector("[data-local-graph-backlinks]");
  tagsInput  = root.querySelector("[data-local-graph-tags]");
  canvas     = root.querySelector("[data-local-graph-canvas]");
  status     = root.querySelector("[data-local-graph-status]");
  if (!(toggle instanceof HTMLButtonElement) || !(depthInput instanceof HTMLInputElement) || !(depthLabel instanceof HTMLElement)
    || !(refsInput instanceof HTMLInputElement) || !(backlinksInput instanceof HTMLInputElement) || !(tagsInput instanceof HTMLInputElement)
    || !(canvas instanceof HTMLElement) || !(status instanceof HTMLElement)) return;

  root.hidden = false;

  toggle.addEventListener("click", () => {
    if (collapsed()) void expandAndRender();
    else setCollapsed(true);
  });
  wireControls();
  setCollapsed(window.localStorage?.getItem(STORAGE_KEY) !== "false");
  if (!collapsed()) void expandAndRender();
}

initPublishedLocalGraph();
