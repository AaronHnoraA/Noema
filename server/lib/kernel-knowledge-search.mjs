import { searchWikiDatabase } from "./wiki-workspace.mjs";

// Every Knowledge search is the kernel's (kernel/noema/wikisearch): free text,
// filters, namespaces, misspellings.  Two things are not searches and stay
// with the host: pages related to the one being read, and what to offer
// before anything is typed.
export function kernelLexicalSearchEligible(body = {}) {
  const query = String(body?.query || body?.q || "").normalize("NFKC").trim();
  const mode = String(body?.mode || "results");
  return mode !== "related" && !(mode === "suggest" && !query);
}

export function createKernelKnowledgeSearch({ baseUrl, box, fetchImpl = globalThis.fetch, timeoutMs = 30_000, onFallback = () => {} } = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const notebook = String(box?.id || "");
  const root = String(box?.root || "");
  if (!base || !notebook || !root || typeof fetchImpl !== "function") {
    throw new Error("Kernel knowledge search requires baseUrl, box.id, box.root, and fetch");
  }

  return async function search(_index, body = {}) {
    const request = {
      notebook,
      query: String(body?.query || body?.q || ""),
      mode: String(body?.mode || ""),
      limit: Number(body?.limit) || 0,
      cursor: Math.max(0, Number(body?.cursor) || 0),
      repositoryId: String(body?.repositoryId || ""),
      partition: String(body?.partition || ""),
      namespace: String(body?.namespace || ""),
      sort: String(body?.sort || ""),
      allowedRepositoryIds: Array.isArray(body?.allowedRepositoryIds) ? body.allowedRepositoryIds.map(String) : [],
      // A reference lookup names the note it is made from and may carry its
      // unsaved text.
      ...(body?.file ? { file: String(body.file) } : {}),
      ...(typeof body?.content === "string" ? { content: body.content } : {}),
    };
    try {
      const response = await fetchImpl(`${base}/api/noema/knowledge/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || Number(payload?.code) !== 0 || !payload?.data) {
        throw new Error(String(payload?.msg || `kernel search failed with HTTP ${response.status}`));
      }
      return payload.data;
    } catch (error) {
      // A kernel that is restarting, or one built before this endpoint, must
      // not leave a person without search.  The host's older implementation
      // answers, without fuzzy matching, and says so.
      onFallback(error);
      // Only the kernel knows how each kind of reference is written.
      if (request.mode === "references") {
        return { ok: false, type: "wiki-references", source: "host-wiki-fallback", items: [], total: 0, explain: ["the kernel is not answering"] };
      }
      return { ...searchWikiDatabase(root, body), source: "host-wiki-fallback" };
    }
  };
}
