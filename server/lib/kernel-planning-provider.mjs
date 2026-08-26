import { kernelMarkdownPath } from "./kernel-markdown-provider.mjs";
import { resolve } from "node:path";

// Planning transport shared by the App and Emacs adapters. Structural parsing
// and atomic source mutation are owned by the Go kernel; the Node host keeps projecting
// note metadata and the established agenda response shape during migration.
export function createKernelPlanningProvider({ baseUrl, box, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const notebook = String(box?.id || "");
  const root = String(box?.root || "");
  if (!base || !notebook || !root || typeof fetchImpl !== "function") {
    throw new Error("Kernel planning provider requires baseUrl, box.id, box.root, and fetch");
  }

  const pathFor = (file) => kernelMarkdownPath(root, file);
  const fileFor = (path) => {
    const normalized = `/${String(path || "").replace(/\\/g, "/").replace(/^\/+/, "")}`;
    if (normalized.split("/").includes("..")) return "";
    const file = resolve(root, `.${normalized}`);
    return pathFor(file) ? file : "";
  };
  async function request(endpoint, body) {
    const response = await fetchImpl(`${base}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || Number(payload?.code) !== 0 || !payload?.data) {
      const err = new Error(String(payload?.msg || `kernel request failed with HTTP ${response.status}`));
      err.statusCode = /(?:planning|block property) document version conflict/i.test(err.message)
        ? 409
        : response.ok ? 502 : response.status;
      throw err;
    }
    return payload.data;
  }
  const post = (endpoint, body) => request(`/api/noema/markdown/${endpoint}`, body);

  return {
    owns(file) {
      return Boolean(pathFor(file));
    },
    async workspaceProjection({ includeProperties = false } = {}) {
      const data = await post("workspaceProjection", {
        notebook,
        includeProperties: includeProperties === true,
      });
      const documents = (Array.isArray(data.documents) ? data.documents : []).map((raw) => {
        const path = `/${String(raw?.path || "").replace(/\\/g, "/").replace(/^\/+/, "")}`;
        const file = fileFor(path);
        const notePath = String(raw?.note?.path || raw?.note?.link || "").replace(/^\/+/, "");
        if (!file || path !== `/${notePath}`) {
          throw Object.assign(new Error("Kernel workspace projection path escapes the registered Markdown box"), { statusCode: 502 });
        }
        return {
          file,
          path,
          note: {
            ...(raw.note && typeof raw.note === "object" ? raw.note : {}),
            file,
            path: notePath,
            link: notePath,
            standalone: false,
          },
          nodes: Array.isArray(raw?.nodes) ? raw.nodes : [],
          blocks: Array.isArray(raw?.blocks) ? raw.blocks : [],
          duplicateDefinitionIds: Array.isArray(raw?.duplicateDefinitionIds)
            ? raw.duplicateDefinitionIds.map(String)
            : [],
          version: String(raw?.version || ""),
          mtimeMs: Number(raw?.mtimeMs || raw?.note?.mtimeMs || 0),
        };
      });
      return {
        documents,
        indexVersion: Number(data.indexVersion) || 0,
        source: String(data.source || "kernel-workspace-projection"),
      };
    },
    async read(file) {
      const path = pathFor(file);
      if (!path) throw Object.assign(new Error("File is outside the kernel Markdown box"), { statusCode: 403 });
      const data = await post("listPlanning", { notebook, path });
      const documents = Array.isArray(data.documents) ? data.documents : [];
      const document = documents.find((candidate) => candidate?.path === path);
      return {
        file: String(file), path,
        nodes: Array.isArray(document?.nodes) ? document.nodes : [],
        version: String(document?.version || ""),
        mtimeMs: Number(document?.mtimeMs || 0),
      };
    },
    async readPropertyBlock(file) {
      const path = pathFor(file);
      if (!path) throw Object.assign(new Error("File is outside the kernel Markdown box"), { statusCode: 403 });
      const data = await post("listPropertyBlocks", { notebook, path });
      const document = (Array.isArray(data.documents) ? data.documents : []).find((candidate) => candidate?.path === path);
      return {
        file: String(file), path,
        blocks: Array.isArray(document?.blocks) ? document.blocks : [],
        duplicateDefinitionIds: Array.isArray(document?.duplicateDefinitionIds) ? document.duplicateDefinitionIds.map(String) : [],
        version: String(document?.version || ""),
        mtimeMs: Number(document?.mtimeMs || 0),
      };
    },
    async mutatePropertyBlock({ file, id = "", key = "", value = null, expectedVersion = "" } = {}) {
      const path = pathFor(file);
      if (!path) throw Object.assign(new Error("File is outside the kernel Markdown box"), { statusCode: 403 });
      return post("mutatePropertyBlock", {
        notebook,
        path,
        expectedVersion: String(expectedVersion || ""),
        id: String(id || ""),
        key: String(key || ""),
        value: value === null || value === undefined || value === "" ? null : String(value),
      });
    },
    async mutate({ file, selector = {}, mutation = {}, expectedVersion = "" } = {}) {
      const path = pathFor(file);
      if (!path) throw Object.assign(new Error("File is outside the kernel Markdown box"), { statusCode: 403 });
      return post("mutatePlanning", {
        notebook,
        path,
        expectedVersion: String(expectedVersion || ""),
        selector,
        mutation,
      });
    },
    async evaluateAgenda(todos = [], todayMs = Date.now(), { projects = [], milestones = [], clocks = [], includePlanning = false, includeGantt = false, from = "", days = 7 } = {}) {
      const projected = (Array.isArray(todos) ? todos : []).map((todo) => ({
        id: String(todo?.id || ""),
        status: String(todo?.status || ""),
        text: String(todo?.text || ""),
        file: String(todo?.file || ""),
        noteTitle: String(todo?.noteTitle || ""),
        index: Number(todo?.index || 0),
        line: Number(todo?.line || 0),
        source: String(todo?.source || ""),
        canon: todo?.canon && typeof todo.canon === "object" ? todo.canon : {},
      }));
      const projectItem = (item) => ({
        id: String(item?.id || ""), status: String(item?.status || ""),
        title: String(item?.title || item?.text || ""), text: String(item?.text || item?.title || ""),
        file: String(item?.file || ""), index: Number(item?.index || 0), line: Number(item?.line || 0),
        source: String(item?.source || ""),
        canon: item?.canon && typeof item.canon === "object" ? item.canon : {},
        args: item?.args && typeof item.args === "object" ? item.args : {},
      });
      return request("/api/noema/agenda/evaluate", {
        todos: projected,
        projects: (Array.isArray(projects) ? projects : []).map(projectItem),
        milestones: (Array.isArray(milestones) ? milestones : []).map(projectItem),
        clocks: (Array.isArray(clocks) ? clocks : []).map(projectItem),
        todayMs: Number(todayMs || Date.now()),
        includeView: true,
        from: String(from || ""),
        days: Number(days || 7),
        includePlanning: includePlanning === true,
        includeGantt: includeGantt === true,
      });
    },
    async evaluateAttributeView({ title = "", source = "", items = [] } = {}) {
      const stringMap = (value) => Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {})
        .map(([key, entry]) => [String(key), String(entry ?? "")]));
      const projected = (Array.isArray(items) ? items : []).map((item) => ({
        id: String(item?.id || ""),
        kind: String(item?.kind || ""),
        status: String(item?.status || ""),
        text: String(item?.text || item?.title || ""),
        title: String(item?.title || item?.text || ""),
        file: String(item?.file || ""),
        noteTitle: String(item?.noteTitle || ""),
        index: Number(item?.index || 0),
        line: Number(item?.line || 0),
        canon: stringMap(item?.canon),
        args: stringMap(item?.args),
      }));
      return request("/api/noema/attribute-view/evaluate", {
        title: String(title || ""),
        source: String(source || ""),
        items: projected,
      });
    },
    async searchEmbed({ statement = "", embedBlockID = "", headingMode = 0, breadcrumb = true, excludeIDs = [] } = {}) {
      const data = await request("/api/search/searchEmbedBlock", {
        embedBlockID: String(embedBlockID || ""),
        stmt: String(statement || ""),
        notebook,
        excludeIDs: (Array.isArray(excludeIDs) ? excludeIDs : []).map(String),
        headingMode: Number(headingMode || 0),
        breadcrumb: breadcrumb !== false,
      });
      return {
        blocks: (Array.isArray(data.blocks) ? data.blocks : []).map((entry) => {
          const block = entry?.block && typeof entry.block === "object" ? entry.block : {};
          const path = String(block.path || "").replace(/\\/g, "/");
          const ial = block.ial && typeof block.ial === "object" ? block.ial : {};
          return {
            id: String(block.id || ""),
            canonicalId: String(ial["custom-noema-id"] || ""),
            rootId: String(block.rootID || ""),
            file: fileFor(path),
            path,
            hPath: String(block.hPath || ""),
            markdown: String(block.markdown || ""),
            type: String(block.type || ""),
            subType: String(block.subType || ""),
            breadcrumb: (Array.isArray(entry?.blockPaths) ? entry.blockPaths : []).map((part) => ({
              id: String(part?.id || ""),
              name: String(part?.name || ""),
              type: String(part?.type || ""),
              subType: String(part?.subType || ""),
            })),
          };
        }).filter((block) => block.file),
      };
    },
  };
}
