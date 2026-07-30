import type { UnusedAsset } from "./types.ts";
import { formatBytes, formatShortDateTime } from "./ui-format.ts";
import { api } from "./api-client.ts";

type ModalField = {
  id: string;
  label: string;
  value?: string;
};

export type UnusedAssetsManager = {
  render: () => void;
  scan: () => Promise<void>;
  trashSelected: () => Promise<void>;
  toggleSelectAll: () => void;
};

export function createUnusedAssetsManager(options: {
  section: HTMLElement;
  count: HTMLElement;
  list: HTMLElement;
  selectAll: HTMLInputElement;
  scanButton: HTMLButtonElement;
  trashButton: HTMLButtonElement;
  setStatus: (text: string) => void;
  openFormModal: (title: string, fields: ModalField[], submitLabel?: string) => Promise<Record<string, string> | null>;
}): UnusedAssetsManager {
  let assets: UnusedAsset[] = [];
  let selected = new Set<string>();
  let loading = false;
  let error = "";

  function updateActions(): void {
    const selectedCount = selected.size;
    options.trashButton.disabled = loading || selectedCount === 0;
    options.trashButton.textContent = selectedCount > 0 ? `Move ${selectedCount} to Trash` : "Move selected to Trash";
    options.scanButton.disabled = loading;
    const selectable = assets.length;
    options.selectAll.checked = selectable > 0 && selectedCount === selectable;
    options.selectAll.indeterminate = selectedCount > 0 && selectedCount < selectable;
  }

  function render(): void {
    options.section.hidden = false;
    const totalBytes = assets.reduce((sum, asset) => sum + asset.size, 0);
    options.count.textContent = loading
      ? "Scanning unused assets"
      : `${assets.length} unused assets · ${formatBytes(totalBytes)}`;
    const frag = document.createDocumentFragment();
    if (error) {
      const empty = document.createElement("div");
      empty.className = "aaronnote-empty";
      empty.textContent = error;
      frag.appendChild(empty);
      options.list.replaceChildren(frag);
      updateActions();
      return;
    }
    if (loading) {
      const empty = document.createElement("div");
      empty.className = "aaronnote-empty";
      empty.textContent = "Scanning";
      frag.appendChild(empty);
      options.list.replaceChildren(frag);
      updateActions();
      return;
    }
    if (assets.length === 0) {
      const empty = document.createElement("div");
      empty.className = "aaronnote-empty";
      empty.textContent = "No unused assets";
      frag.appendChild(empty);
      options.list.replaceChildren(frag);
      updateActions();
      return;
    }
    for (const asset of assets) {
      const row = document.createElement("label");
      row.className = "aaronnote-unused-asset";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected.has(asset.file);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selected.add(asset.file);
        else selected.delete(asset.file);
        updateActions();
      });
      const kind = document.createElement("span");
      kind.className = "aaronnote-unused-asset-kind";
      kind.textContent = asset.isImage ? "IMG" : "FILE";
      const body = document.createElement("span");
      body.className = "aaronnote-unused-asset-body";
      const path = document.createElement("strong");
      path.textContent = asset.path || asset.file;
      const meta = document.createElement("span");
      meta.textContent = `${formatBytes(asset.size)} · ${formatShortDateTime(asset.mtimeMs)}`;
      body.append(path, meta);
      row.append(checkbox, kind, body);
      frag.appendChild(row);
    }
    options.list.replaceChildren(frag);
    updateActions();
  }

  async function scan(): Promise<void> {
    if (loading) return;
    loading = true;
    error = "";
    selected = new Set();
    render();
    options.setStatus("Scanning unused assets");
    try {
      const msg = await api.assets.scanOrphans();
      if (!Array.isArray(msg.assets)) throw new Error(msg.message || "Asset scan failed");
      assets = msg.assets;
      options.setStatus(`Found ${assets.length} unused assets`);
    } catch (err) {
      assets = [];
      error = err instanceof Error ? err.message : "Asset scan failed";
      options.setStatus(error);
    } finally {
      loading = false;
      render();
    }
  }

  async function trashSelected(): Promise<void> {
    const files = [...selected];
    if (files.length === 0 || loading) return;
    const confirmed = await options.openFormModal("Move unused assets", [
      { id: "confirm", label: `Type TRASH to move ${files.length} selected unused assets to Trash`, value: "" },
    ], "Move to Trash");
    if (confirmed?.confirm !== "TRASH") return;
    loading = true;
    error = "";
    render();
    options.setStatus("Moving unused assets to Trash");
    try {
      const msg = await api.assets.trashOrphans(files);
      if (!Array.isArray(msg.assets)) throw new Error(msg.message || "Move to Trash failed");
      assets = msg.assets;
      selected = new Set();
      options.setStatus(`Moved ${(msg.trashed ?? []).length} assets to Trash`);
    } catch (err) {
      error = err instanceof Error ? err.message : "Move to Trash failed";
      options.setStatus(error);
    } finally {
      loading = false;
      render();
    }
  }

  function toggleSelectAll(): void {
    selected = options.selectAll.checked
      ? new Set(assets.map((asset) => asset.file))
      : new Set();
    render();
  }

  return { render, scan, trashSelected, toggleSelectAll };
}
