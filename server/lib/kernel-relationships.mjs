import { kernelMarkdownPath } from "./kernel-markdown-provider.mjs";

export function createKernelRelationshipOverlay({ baseUrl, box, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const notebook = String(box?.id || "");
  const root = String(box?.root || "");
  if (!base || !notebook || !root || typeof fetchImpl !== "function") {
    throw new Error("Kernel relationship overlay requires baseUrl, box.id, box.root, and fetch");
  }

  return async function overlay(index) {
    const response = await fetchImpl(`${base}/api/noema/markdown/listRelationships`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notebook }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || Number(payload?.code) !== 0 || !payload?.data) {
      const err = new Error(String(payload?.msg || `kernel relationship query failed with HTTP ${response.status}`));
      err.statusCode = response.ok ? 502 : response.status;
      throw err;
    }

    const noteByPath = new Map();
    const notes = (index?.notes || []).map((note) => {
      const copy = { ...note, refs: [...(note?.refs || [])], backlinks: [...(note?.backlinks || [])] };
      const path = kernelMarkdownPath(root, note?.file);
      if (path) noteByPath.set(path, copy);
      return copy;
    });
    for (const relationship of payload.data.relationships || []) {
      const from = noteByPath.get(String(relationship?.fromPath || "").replace(/\\/g, "/"));
      const to = noteByPath.get(String(relationship?.toPath || "").replace(/\\/g, "/"));
      if (!from || !to) continue;
      const targetID = String(to.id || to.pageKey || to.file || "");
      const sourceID = String(from.id || from.pageKey || from.file || "");
      if (targetID && !from.refs.includes(targetID)) from.refs.push(targetID);
      if (sourceID && !to.backlinks.includes(sourceID)) to.backlinks.push(sourceID);
    }
    for (const note of notes) {
      note.refs.sort();
      note.backlinks.sort();
    }
    return { ...index, notes, relationshipSource: "kernel-refs" };
  };
}
