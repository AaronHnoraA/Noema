import { kernelMarkdownPath } from "./kernel-markdown-provider.mjs";

const structuredQueryPattern = /(?:^|\s)-?(?:tag|title|repo|namespace|path|kind|linksto|is):/iu;

export function kernelLexicalSearchEligible(body = {}) {
  const query = String(body?.query || body?.q || "").normalize("NFKC").trim();
  const mode = String(body?.mode || "results");
  return Boolean(query) && mode !== "related" && !structuredQueryPattern.test(query);
}

function excerptFromKernel(value) {
  return String(value || "")
    .replaceAll("<mark>", "[[")
    .replaceAll("</mark>", "]]")
    .replace(/\s+/gu, " ")
    .trim();
}

export function createKernelKnowledgeSearch({ baseUrl, box, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const notebook = String(box?.id || "");
  const root = String(box?.root || "");
  if (!base || !notebook || !root || typeof fetchImpl !== "function") {
    throw new Error("Kernel knowledge search requires baseUrl, box.id, box.root, and fetch");
  }

  return async function search(index, body = {}) {
    const query = String(body?.query || body?.q || "").normalize("NFKC").trim();
    const limit = Math.max(1, Math.min(100, Number(body?.limit) || 40));
    const offset = Math.max(0, Number(body?.cursor) || 0);
    const page = Math.floor(offset / limit) + 1;
    const response = await fetchImpl(`${base}/api/search/fullTextSearchBlock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        page,
        pageSize: limit,
        paths: [`${notebook}/`],
        method: 0,
        orderBy: 7,
        groupBy: 0,
        searchHPath: true,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || Number(payload?.code) !== 0 || !payload?.data) {
      const err = new Error(String(payload?.msg || `kernel search failed with HTTP ${response.status}`));
      err.statusCode = response.ok ? 502 : response.status;
      throw err;
    }

    const noteByPath = new Map();
    for (const note of index?.notes || []) {
      const path = kernelMarkdownPath(root, note?.file);
      if (path) noteByPath.set(path, note);
    }
    const seen = new Set();
    const items = [];
    for (const block of payload.data.blocks || []) {
      const path = String(block?.path || "").replace(/\\/g, "/");
      if (String(block?.box || "") !== notebook || seen.has(path)) continue;
      const note = noteByPath.get(path.startsWith("/") ? path : `/${path}`);
      if (!note) continue;
      seen.add(path);
      items.push({
        ...note,
        excerpt: excerptFromKernel(block?.content || block?.fcontent),
        rank: items.length,
      });
    }
    const reportedTotal = Number(payload.data.matchedRootCount ?? payload.data.matchedBlockCount) || 0;
    const total = items.length ? Math.max(items.length, reportedTotal) : 0;
    return {
      ok: true,
      type: "wiki-search",
      generation: String(index?.generation || ""),
      items,
      total,
      nextCursor: offset + items.length < total ? offset + items.length : null,
      source: "kernel-fts5",
    };
  };
}
