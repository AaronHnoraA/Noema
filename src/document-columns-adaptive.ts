import type { AdaptiveColumns, layoutAdaptiveColumns } from "../shared/columns-adaptive.mjs";

/** Kept self-contained so the reader can include the same behavior in Standalone HTML. */
export function connectAdaptiveColumns(
  root: ParentNode, solve: typeof layoutAdaptiveColumns, onLayout?: () => void,
): () => void {
  const cleanups: Array<() => void> = [];
  const selector = ".noema-columns-adaptive[data-columns-config]";
  const groups = Array.from(root.querySelectorAll<HTMLElement>(selector));
  if (root instanceof HTMLElement && root.matches(selector)) groups.unshift(root);
  for (const group of groups) {
    if (group.dataset.columnsConnected) continue;
    const doc = group.ownerDocument;
    const frame = doc.defaultView;
    if (!frame?.ResizeObserver) continue;
    const grid = group.querySelector<HTMLElement>(":scope > .cm-columns-content") || group;
    const panes = Array.from(grid.querySelectorAll<HTMLElement>(":scope > [data-col-index]"));
    if (!panes.length) continue;
    let spec: AdaptiveColumns;
    try { spec = JSON.parse(group.dataset.columnsConfig!) as AdaptiveColumns; }
    catch { continue; }
    if (!spec?.minimum || !spec.gap || !spec.padding) continue;
    const growth = panes.map((pane) => Number(pane.dataset.columnGrow) || 1);
    group.dataset.columnsConnected = "true";
    const meter = doc.createElement("div");
    meter.className = "noema-columns-meter";
    meter.setAttribute("aria-hidden", "true");
    const probes = ["ch", "em", "rem", "lh"].map((unit) => {
      const probe = doc.createElement("span");
      probe.style.inlineSize = `100${unit}`;
      meter.append(probe);
      return probe;
    });
    group.append(meter);
    let breaks: HTMLElement[] = [];
    let signature = "";
    let frameRequest = 0;
    const measure = () => {
      if (!group.isConnected) {
        dispose();
        return;
      }
      const box = frame.getComputedStyle(grid);
      const preciseWidth = parseFloat(box.width) - (parseFloat(box.borderInlineStartWidth) || 0) - (parseFloat(box.borderInlineEndWidth) || 0);
      const width = Math.max(0, Math.min(grid.clientWidth, preciseWidth || grid.clientWidth) - 0.125);
      if (!width) return;
      const units = probes.map((probe) => Math.max(1, parseFloat(frame.getComputedStyle(probe).width) / 100));
      const key = [width, ...units].join(":");
      if (key === signature) return;
      signature = key;
      const [ch, em, rem, lh] = units as [number, number, number, number];
      const layout = solve(spec, growth, { width, ch, em, rem, lh });
      grid.style.setProperty("--noema-columns-gap", `${layout.gap}px`);
      grid.style.setProperty("--noema-columns-padding", `${layout.padding}px`);
      grid.style.setProperty("--noema-columns-justify", spec.justify);
      grid.dataset.columnsReady = "true";
      breaks.forEach((element) => element.remove());
      breaks = [];
      let index = 0;
      for (const [rowIndex, row] of layout.rows.entries()) {
        if (rowIndex > 0 && row.length) {
          const separator = doc.createElement("span");
          separator.className = "noema-columns-row-break";
          separator.setAttribute("aria-hidden", "true");
          grid.insertBefore(separator, panes[index]!);
          breaks.push(separator);
        }
        row.forEach((basis, indexInRow) => {
          const pane = panes[index++]!;
          pane.style.setProperty("--noema-column-width", `${Math.max(0, Math.floor(basis * 64) / 64)}px`);
          pane.dataset.columnRowStart = String(indexInRow === 0);
          pane.dataset.columnLastRow = String(rowIndex === layout.rows.length - 1);
          pane.dataset.columnStacked = String(layout.rows.length > 1 && row.length === 1);
        });
      }
      onLayout?.();
    };
    const schedule = () => {
      if (frameRequest) return;
      frameRequest = frame.requestAnimationFrame(() => {
        frameRequest = 0;
        measure();
      });
    };
    const observer = new frame.ResizeObserver(schedule);
    const dispose = () => {
      observer.disconnect();
      if (frameRequest) frame.cancelAnimationFrame(frameRequest);
      delete group.dataset.columnsConnected;
      meter.remove();
      breaks.forEach((element) => element.remove());
    };
    observer.observe(grid);
    probes.forEach((probe) => observer.observe(probe));
    schedule();
    cleanups.push(dispose);
  }
  return () => { cleanups.forEach((dispose) => dispose()); };
}
