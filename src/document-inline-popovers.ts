export const INLINE_READING_CONTROL_SELECTOR = ".noema-inline-control, .noema-inline-popover-button, .noema-inline-popover";

/** Also embedded as a self-contained function in published notes. */
export function connectInlineReadingPopovers(root: ParentNode, layoutChanged?: () => void): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-inline-popover-trigger]")) {
    const panel = button.nextElementSibling;
    if (!(panel instanceof HTMLElement) || !panel.classList.contains("noema-inline-popover") || button.onclick) continue;
    const doc = button.ownerDocument;
    const frame = doc.defaultView;
    if (!frame) continue;
    const native = typeof panel.showPopover === "function";
    let tracking: AbortController | null = null;
    let paragraph: HTMLElement | null = null;
    let originalPadding = 0;
    const reserve = (amount: number) => {
      const height = paragraph ? parseFloat(frame.getComputedStyle(paragraph).lineHeight) || 24 : 24;
      const rows = amount && paragraph ? String(Math.max(1, Math.min(5, Math.ceil((amount + originalPadding) / height)))) : undefined;
      if (panel.dataset.inlineRoom === rows) return;
      if (rows) panel.dataset.inlineRoom = rows;
      else delete panel.dataset.inlineRoom;
      layoutChanged?.();
    };
    const position = (reveal = false) => {
      if (!button.isConnected) { reserve(0); tracking?.abort(); tracking = null; return; }
      const anchor = button.getBoundingClientRect();
      const line = paragraph?.getBoundingClientRect() ?? anchor;
      const pageRight = doc.documentElement.clientWidth - 12;
      const useMeasure = line.width >= 180;
      const right = useMeasure ? Math.min(pageRight, line.right) : pageRight;
      const leftEdge = useMeasure ? Math.max(12, line.left) : 12;
      panel.style.setProperty("--inline-popover-measure", `${Math.max(0, right - leftEdge)}px`);
      const bottom = frame.innerHeight - 12;
      const left = Math.max(leftEdge, Math.min(anchor.left, right - panel.offsetWidth));
      reserve(panel.offsetHeight + 12);
      const belowParagraph = () => {
        if (!paragraph) return anchor.bottom + 6;
        const padding = parseFloat(frame.getComputedStyle(paragraph).paddingBlockEnd) || 0;
        return paragraph.getBoundingClientRect().bottom - Math.max(0, padding - originalPadding) + 6;
      };
      if (reveal && paragraph && belowParagraph() + panel.offsetHeight > bottom) {
        paragraph.scrollIntoView({ block: "end", inline: "nearest", behavior: "instant" });
      }
      panel.style.left = `${left}px`;
      panel.style.top = `${belowParagraph()}px`;
    };
    const show = (open: boolean) => {
      const reveal = open && tracking === null;
      button.setAttribute("aria-expanded", String(open));
      tracking?.abort();
      tracking = null;
      if (!open) { reserve(0); return; }
      const anchor = button.closest<HTMLElement>(".cm-line, p, li, h1, h2, h3, h4, h5, h6");
      if (anchor !== paragraph) {
        reserve(0);
        paragraph = anchor;
        originalPadding = paragraph ? parseFloat(frame.getComputedStyle(paragraph).paddingBlockEnd) || 0 : 0;
      }
      tracking = new AbortController();
      const { signal } = tracking;
      frame.addEventListener("resize", () => position(), { signal, passive: true });
      doc.addEventListener("scroll", () => position(), { signal, capture: true, passive: true });
      if (!native) {
        doc.addEventListener("click", (event) => {
          if (event.target instanceof Node && (panel.contains(event.target) || button.contains(event.target))) return;
          panel.removeAttribute("data-popover-open");
          show(false);
        }, { signal });
        doc.addEventListener("keydown", (event) => {
          if (event.key !== "Escape") return;
          panel.removeAttribute("data-popover-open");
          show(false);
          button.focus({ preventScroll: true });
        }, { signal });
      }
      position(reveal);
    };
    if (native) panel.addEventListener("toggle", () => show(panel.matches(":popover-open")));
    button.onclick = () => {
      const open = native ? panel.matches(":popover-open") : panel.hasAttribute("data-popover-open");
      if (native) {
        if (open) panel.hidePopover();
        else {
          panel.showPopover({ source: button });
          for (const previous of doc.querySelectorAll(".noema-inline-popover[data-inline-room]:not(:popover-open)")) {
            previous.removeAttribute("data-inline-room");
          }
        }
      } else panel.toggleAttribute("data-popover-open", !open);
      show(!open);
    };
  }
}
