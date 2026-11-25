/** Reading controls are embedded as a self-contained script in standalone HTML. */
export function connectStandaloneReading(doc: Document): void {
  const root = doc.documentElement;
  const theme = doc.querySelector<HTMLButtonElement>("[data-standalone-theme]");
  theme?.addEventListener("click", () => {
    const current = root.dataset.noemaTheme || root.dataset.noemaThemePrimary || "noema";
    const next = current === root.dataset.noemaThemePrimary
      ? root.dataset.noemaThemeAlternate : root.dataset.noemaThemePrimary;
    if (next) root.dataset.noemaTheme = next;
  });

  const outline = doc.querySelector<HTMLElement>("[data-published-toc]");
  const list = outline?.querySelector<HTMLElement>("[data-toc-list]");
  const trigger = doc.querySelector<HTMLButtonElement>("[data-toc-toggle]");
  const setOutline = (open: boolean) => {
    if (!outline || !trigger) return;
    outline.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
  };
  if (list && trigger) {
    const headings = [...doc.querySelectorAll<HTMLElement>("#content :is(h1,h2,h3,h4,h5,h6)")]
      .filter((heading) => !heading.closest('org-env-block[data-kind="comment"]'));
    headings.forEach((heading, index) => {
      if (!heading.id) {
        let id = `noema-heading-${index + 1}`;
        while (doc.getElementById(id)) id += "-outline";
        heading.id = id;
      }
      const link = doc.createElement("a");
      link.href = "#" + encodeURIComponent(heading.id);
      link.textContent = heading.textContent?.trim() || "Heading";
      link.dataset.level = heading.tagName.slice(1);
      link.addEventListener("click", () => {
        setOutline(false);
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      });
      list.append(link);
    });
    trigger.hidden = headings.length === 0;
    trigger.addEventListener("click", () => {
      const open = Boolean(outline?.hidden);
      setOutline(open);
      if (open) list.querySelector("a")?.focus({ preventScroll: true });
    });
  }

  const spoilers = doc.querySelector<HTMLButtonElement>("[data-standalone-spoilers]");
  const spoilerInputs = [...doc.querySelectorAll<HTMLInputElement>("#content .noema-inline-spoiler .noema-inline-toggle")];
  const updateSpoilers = () => {
    const open = spoilerInputs.filter((item) => item.checked).length;
    spoilers?.setAttribute("aria-pressed", open === 0 ? "false" : open === spoilerInputs.length ? "true" : "mixed");
  };
  const toggleSpoilers = () => {
    if (!spoilers) return;
    const reveal = spoilers.getAttribute("aria-pressed") !== "true";
    for (const item of spoilerInputs) {
      item.checked = reveal;
    }
    updateSpoilers();
  };
  spoilers?.addEventListener("click", toggleSpoilers);
  for (const item of spoilerInputs) item.addEventListener("change", updateSpoilers);
  doc.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    if (event.key === "Escape" && outline && !outline.hidden) {
      event.preventDefault();
      setOutline(false);
      trigger?.focus({ preventScroll: true });
    } else if (event.shiftKey && event.key.toLowerCase() === "s" && spoilers) {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.isContentEditable || target?.matches('input:not([type="checkbox"]), textarea, select')) return;
      event.preventDefault();
      toggleSpoilers();
    }
  });
}
