const STORAGE_KEY = "aaronnote-published-toc-collapsed";
const HEADING_SELECTOR = ".aaronnote-section-heading, h1:not(.title), h2, h3, h4, h5, h6";

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function slugify(value) {
  const slug = normalizeText(value)
    .toLowerCase()
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "section";
}

function ensureHeadingIds(headings) {
  const used = new Set();
  headings.forEach((heading) => {
    let id = heading.id.trim();
    if (!id || used.has(id)) {
      const base = slugify(heading.textContent);
      id = base;
      let suffix = 2;
      while (used.has(id) || document.getElementById(id)) {
        id = `${base}-${suffix}`;
        suffix += 1;
      }
      heading.id = id;
    }
    used.add(id);
  });
}

function collectHeadings(article) {
  const headings = Array.from(article.querySelectorAll(HEADING_SELECTOR))
    .filter((heading) => heading instanceof HTMLElement)
    .filter((heading) => !heading.closest("[hidden], [aria-hidden='true'], .aaronnote-meta-abstract-content"));
  const hasSemantic = headings.some((heading) => heading.classList.contains("aaronnote-section-heading"));
  ensureHeadingIds(headings);
  return headings.map((heading) => ({
    id: heading.id,
    level: heading.classList.contains("aaronnote-section-heading")
      ? Number(heading.dataset.outlineLevel) || 2
      : (hasSemantic ? 5 : 0) + (Number(heading.tagName.slice(1)) || 1),
    text: heading.classList.contains("aaronnote-section-heading")
      ? normalizeText(heading.querySelector(".aaronnote-section-title")?.textContent || heading.textContent) || "Untitled"
      : normalizeText(heading.textContent) || "Untitled",
    element: heading,
  }));
}

function scrollToHeading(heading, behavior = "smooth") {
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const top = heading.getBoundingClientRect().top + window.scrollY - 82;
  window.scrollTo({
    top: Math.max(0, top),
    behavior: reducedMotion ? "auto" : behavior,
  });
}

function initPublishedToc() {
  const article = document.getElementById("content");
  const toc = document.querySelector("[data-published-toc]");
  const list = toc?.querySelector("[data-toc-list]");
  const toggle = toc?.querySelector("[data-toc-toggle]");
  if (!(article instanceof HTMLElement) || !(toc instanceof HTMLElement) || !(list instanceof HTMLElement) || !(toggle instanceof HTMLButtonElement)) {
    return;
  }

  let headings = [];
  let activeId = "";
  let renderKey = "";
  let frame = 0;

  function setCollapsed(collapsed) {
    toc.classList.toggle("is-collapsed", collapsed);
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    window.localStorage?.setItem(STORAGE_KEY, String(collapsed));
  }

  function activeHeadingId() {
    if (headings.length === 0) return "";
    let current = headings[0].id;
    headings.forEach((heading) => {
      if (heading.element.getBoundingClientRect().top <= 96) {
        current = heading.id;
      }
    });
    return current;
  }

  function updateActive() {
    activeId = activeHeadingId();
    list.querySelectorAll(".aaronnote-toc-item").forEach((button) => {
      const active = button.getAttribute("data-heading-id") === activeId;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "location");
      else button.removeAttribute("aria-current");
    });
  }

  function scheduleActiveUpdate() {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      updateActive();
    });
  }

  function render() {
    headings = collectHeadings(article);
    const key = headings.map((heading) => `${heading.level}:${heading.id}:${heading.text}`).join("\n");
    if (key === renderKey) {
      updateActive();
      return;
    }
    renderKey = key;
    toc.hidden = headings.length === 0;
    toggle.textContent = headings.length > 0 ? `Page ${headings.length}` : "Page";
    if (headings.length === 0) {
      list.replaceChildren();
      return;
    }

    const frag = document.createDocumentFragment();
    const status = document.createElement("div");
    status.className = "aaronnote-toc-status";
    status.textContent = `${headings.length} headings`;
    frag.appendChild(status);

    headings.forEach((heading) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "aaronnote-toc-item";
      button.style.setProperty("--toc-depth", String(Math.max(0, heading.level - 1)));
      button.dataset.headingId = heading.id;
      button.dataset.level = String(heading.level);
      button.title = heading.text;
      button.textContent = heading.text;
      button.addEventListener("click", () => {
        scrollToHeading(heading.element);
        window.history.replaceState(null, "", `#${encodeURIComponent(heading.id)}`);
        updateActive();
      });
      frag.appendChild(button);
    });

    list.replaceChildren(frag);
    updateActive();
  }

  function scheduleRender() {
    window.requestAnimationFrame(render);
  }

  const stored = window.localStorage?.getItem(STORAGE_KEY);
  setCollapsed(stored === null ? true : stored === "true");
  toggle.addEventListener("click", () => setCollapsed(!toc.classList.contains("is-collapsed")));
  window.addEventListener("scroll", scheduleActiveUpdate, { passive: true });
  window.addEventListener("resize", scheduleActiveUpdate);
  window.addEventListener("aaronnote:kind-ready", scheduleRender);

  const observer = new MutationObserver(scheduleRender);
  observer.observe(article, { childList: true, subtree: true, characterData: true });
  render();

  if (window.location.hash) {
    const targetId = decodeURIComponent(window.location.hash.slice(1));
    const target = document.getElementById(targetId);
    if (target instanceof HTMLElement && article.contains(target)) {
      window.requestAnimationFrame(() => scrollToHeading(target, "auto"));
    }
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initPublishedToc, { once: true });
} else {
  initPublishedToc();
}
