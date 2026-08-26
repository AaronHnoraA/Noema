import { api, type AssetContentItem, type MissingAsset } from "./api-client.ts";
import type { UnusedAsset } from "./types.ts";
import { formatBytes } from "./ui-format.ts";

type AssetHealth = { unused: UnusedAsset[]; missing: MissingAsset[]; source?: string };

export function openAssetMaintenance(options: {
  reveal?: (file: string) => void;
  setStatus?: (message: string) => void;
} = {}): { close: () => void } {
  document.querySelector<HTMLElement>(".noema-asset-maintenance")?.remove();
  const root = document.createElement("div");
  root.className = "aaronnote-modal noema-asset-maintenance";
  const panel = document.createElement("section");
  panel.className = "aaronnote-modal-panel noema-asset-maintenance-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "Asset maintenance");
  const header = document.createElement("header");
  const title = document.createElement("h2");
  title.textContent = "Assets";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = "Close";
  header.append(title, closeButton);
  const status = document.createElement("p");
  status.className = "noema-asset-maintenance-status";
  const searchForm = document.createElement("form");
  searchForm.className = "noema-asset-search-form";
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.placeholder = "Search inside PDF, Office, EPUB and text attachments";
  searchInput.setAttribute("aria-label", "Search attachment contents");
  const searchButton = document.createElement("button");
  searchButton.type = "submit";
  searchButton.textContent = "Search contents";
  searchForm.append(searchInput, searchButton);
  const searchResults = document.createElement("div");
  searchResults.className = "noema-asset-maintenance-list";
  const healthHeader = document.createElement("div");
  healthHeader.className = "noema-asset-maintenance-section-header";
  const healthTitle = document.createElement("strong");
  healthTitle.textContent = "Repository health";
  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.textContent = "Scan";
  healthHeader.append(healthTitle, refreshButton);
  const healthResults = document.createElement("div");
  healthResults.className = "noema-asset-maintenance-list";
  panel.append(header, status, searchForm, searchResults, healthHeader, healthResults);
  root.appendChild(panel);
  document.body.appendChild(root);

  let closed = false;
  let healthGeneration = 0;
  let searchGeneration = 0;
  const setStatus = (message: string): void => {
    status.textContent = message;
    options.setStatus?.(message);
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    healthGeneration++;
    searchGeneration++;
    document.removeEventListener("keydown", onKeydown, true);
    root.remove();
  };
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    close();
  };
  document.addEventListener("keydown", onKeydown, true);
  closeButton.addEventListener("click", close);
  root.addEventListener("mousedown", (event) => { if (event.target === root) close(); });

  const empty = (message: string): HTMLElement => {
    const item = document.createElement("p");
    item.className = "aaronnote-empty";
    item.textContent = message;
    return item;
  };
  const row = (titleText: string, detailText: string, file?: string): HTMLElement => {
    const item = document.createElement("article");
    item.className = "noema-asset-maintenance-item";
    const body = document.createElement("div");
    const heading = document.createElement("strong");
    heading.textContent = titleText;
    const detail = document.createElement("span");
    detail.textContent = detailText;
    body.append(heading, detail);
    item.appendChild(body);
    if (file && options.reveal) {
      const reveal = document.createElement("button");
      reveal.type = "button";
      reveal.textContent = "Reveal";
      reveal.addEventListener("click", () => options.reveal?.(file));
      item.appendChild(reveal);
    }
    return item;
  };

  const renderHealth = (health: AssetHealth): void => {
    healthResults.replaceChildren();
    const summary = document.createElement("p");
    summary.className = "noema-asset-maintenance-summary";
    summary.textContent = `${health.unused.length} unused · ${health.missing.length} missing · ${health.source || "asset scan"}`;
    healthResults.appendChild(summary);
    for (const asset of health.unused) {
      const item = row(asset.path, `Unused · ${formatBytes(asset.size)}`, asset.file);
      const rename = document.createElement("button");
      rename.type = "button";
      rename.textContent = "Rename";
      rename.addEventListener("click", async () => {
        const newName = window.prompt("New asset filename", asset.name)?.trim();
        if (!newName || newName === asset.name) return;
        try {
          const result = await api.assets.rename({ oldPath: asset.file, newName });
          setStatus(`Renamed to ${result.newPath || newName} · ${(result.rewrittenNotes || []).length} notes updated`);
          await inspect();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Asset rename failed");
        }
      });
      const trash = document.createElement("button");
      trash.type = "button";
      trash.textContent = "Move to Trash";
      trash.addEventListener("click", async () => {
        if (!window.confirm(`Move unused asset “${asset.path}” to Trash?`)) return;
        try {
          await api.assets.trashOrphans([asset.file]);
          setStatus(`Moved ${asset.path} to Trash`);
          await inspect();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Moving asset failed");
        }
      });
      item.append(rename, trash);
      healthResults.appendChild(item);
    }
    for (const asset of health.missing) {
      healthResults.appendChild(row(asset.path, `Missing · referenced by ${asset.notePath}`, asset.noteFile));
    }
    if (!health.unused.length && !health.missing.length) healthResults.appendChild(empty("No unused or missing assets."));
  };

  const inspect = async (): Promise<void> => {
    const run = ++healthGeneration;
    refreshButton.disabled = true;
    setStatus("Scanning unused and missing assets…");
    try {
      const health = await api.assets.inspect();
      if (closed || run !== healthGeneration) return;
      renderHealth(health);
      setStatus(`Asset scan complete · ${health.unused.length} unused · ${health.missing.length} missing`);
    } catch (error) {
      if (!closed && run === healthGeneration) {
        healthResults.replaceChildren(empty(error instanceof Error ? error.message : "Asset scan failed"));
        setStatus(error instanceof Error ? error.message : "Asset scan failed");
      }
    } finally {
      if (!closed && run === healthGeneration) refreshButton.disabled = false;
    }
  };

  const renderSearch = (items: AssetContentItem[], total: number, indexed: number): void => {
    searchResults.replaceChildren();
    const summary = document.createElement("p");
    summary.className = "noema-asset-maintenance-summary";
    summary.textContent = `${total} matches · ${indexed} indexed attachments`;
    searchResults.appendChild(summary);
    for (const item of items) {
      const result = row(item.path || item.name, item.content.replace(/<\/?mark>/g, ""), item.file);
      if (item.file) {
        const rename = document.createElement("button");
        rename.type = "button";
        rename.textContent = "Rename";
        rename.addEventListener("click", async () => {
          const newName = window.prompt("New asset filename", item.name)?.trim();
          if (!newName || newName === item.name) return;
          try {
            const renamed = await api.assets.rename({ oldPath: item.file!, newName });
            setStatus(`Renamed to ${String(renamed.newPath || newName)} · ${(renamed.rewrittenNotes || []).length} notes updated`);
            await inspect();
            searchForm.requestSubmit();
          } catch (error) {
            setStatus(error instanceof Error ? error.message : "Asset rename failed");
          }
        });
        result.appendChild(rename);
      }
      searchResults.appendChild(result);
    }
    if (!items.length) searchResults.appendChild(empty("No attachment content matched."));
  };

  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = searchInput.value.trim();
    if (!query) return;
    const run = ++searchGeneration;
    searchButton.disabled = true;
    setStatus("Indexing and searching attachment contents…");
    void api.assets.searchContent({ query, limit: 50 }).then((result) => {
      if (closed || run !== searchGeneration) return;
      renderSearch(result.assets, result.total, result.indexed);
      setStatus(`Found ${result.total} attachment content matches`);
    }).catch((error) => {
      if (!closed && run === searchGeneration) setStatus(error instanceof Error ? error.message : "Attachment search failed");
    }).finally(() => {
      if (!closed && run === searchGeneration) searchButton.disabled = false;
    });
  });
  refreshButton.addEventListener("click", () => void inspect());
  void inspect();
  queueMicrotask(() => searchInput.focus());
  return { close };
}
