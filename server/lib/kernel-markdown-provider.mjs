import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isBlockReferenceId } from "../../shared/block-identity.mjs";

const markdownExtensions = new Set([".md", ".markdown"]);

function canonicalExistingPath(path) {
  const resolved = resolve(String(path || ""));
  let probe = resolved;
  const missingParts = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return resolved;
    missingParts.unshift(basename(probe));
    probe = parent;
  }
  try {
    const real = realpathSync.native(probe);
    return missingParts.length ? join(real, ...missingParts) : real;
  } catch {
    return resolved;
  }
}

export function kernelBoxPath(root, file) {
  const canonicalRoot = canonicalExistingPath(root);
  const canonicalFile = canonicalExistingPath(file);
  const rel = relative(canonicalRoot, canonicalFile);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return "";
  return `/${rel.split(sep).join("/")}`;
}

export function kernelMarkdownPath(root, file) {
  const path = kernelBoxPath(root, file);
  if (!path || !markdownExtensions.has(extname(path).toLowerCase())) return "";
  return path;
}

// Box-relative paths minted by the kernel are validated lexically rather than
// by canonicalising every entry. kernelBoxPath() resolves symlinks with a
// realpath(3) walk per call, which is the right check for a host-supplied path
// but ruinous for a catalog: it ran twice per note on every catalog fetch and
// was the single largest consumer of Node host CPU while typing. A path with no
// empty, "." or ".." segment and no backslash cannot leave the box once it is
// resolved under the box root, which is the guarantee the catalog needs.
export function kernelRelativeBoxPath(rawPath) {
  const raw = String(rawPath || "");
  if (!raw || raw.includes("\\")) return "";
  const relativePath = raw.replace(/^\/+/, "");
  if (!relativePath) return "";
  const parts = relativePath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return "";
  return relativePath;
}

export function createKernelMarkdownProvider({ baseUrl, box, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const notebook = String(box?.id || "");
  const root = String(box?.root || "");
  if (!base || !notebook || !root || typeof fetchImpl !== "function") {
    throw new Error("Kernel Markdown provider requires baseUrl, box.id, box.root, and fetch");
  }

  function pathFor(file) {
    return kernelMarkdownPath(root, file);
  }

  async function post(path, body) {
    const response = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || Number(payload?.code) !== 0 || !payload?.data) {
      const err = new Error(String(payload?.msg || `kernel request failed with HTTP ${response.status}`));
      err.statusCode = response.ok ? 502 : response.status;
      throw err;
    }
    return payload.data;
  }

  function mapNote(raw, label = "Kernel note catalog") {
    const relativePath = kernelRelativeBoxPath(raw?.path || raw?.link);
    const file = relativePath && markdownExtensions.has(extname(relativePath).toLowerCase())
      ? resolve(root, ...relativePath.split("/"))
      : "";
    if (!file) {
      throw Object.assign(new Error(`${label} path escapes the registered Markdown box`), { statusCode: 502 });
    }
    return {
      ...raw,
      file,
      path: relativePath,
      link: relativePath,
      standalone: false,
    };
  }

  function mapVirtualMentionPath(rawPath) {
    if (!String(rawPath || "")) {
      throw Object.assign(new Error("Kernel virtual-reference mention path is invalid"), { statusCode: 502 });
    }
    const relativePath = kernelRelativeBoxPath(rawPath);
    if (!relativePath || !markdownExtensions.has(extname(relativePath).toLowerCase())) {
      throw Object.assign(new Error("Kernel virtual-reference mention path escapes the registered Markdown box"), { statusCode: 502 });
    }
    return relativePath;
  }

  return {
    owns(file) {
      return Boolean(pathFor(file));
    },
    ownsPath(file) {
      return Boolean(kernelBoxPath(root, file));
    },
    async catalog(force = false) {
      const data = await post("/api/noema/markdown/catalog", { notebook, force: force === true });
      if (!Array.isArray(data.notes)) {
        throw Object.assign(new Error("Kernel note catalog response is missing notes"), { statusCode: 502 });
      }
      const notes = data.notes.map((raw) => mapNote(raw));
      return {
        type: "notes",
        notes,
        directories: Array.isArray(data.directories) ? data.directories : [],
        files: Array.isArray(data.files) ? data.files : [],
        indexVersion: Number(data.indexVersion) || 0,
        source: String(data.source || "kernel-note-catalog"),
      };
    },
    async virtualReferences(body = {}) {
      const requestedFile = String(body?.file || "");
      const requestedPath = requestedFile ? pathFor(requestedFile) : String(body?.path || "");
      if (requestedFile && !requestedPath) {
        throw Object.assign(new Error("Virtual-reference target is outside the kernel Markdown box"), { statusCode: 403 });
      }
      const data = await post("/api/noema/markdown/virtualReferences", {
        notebook,
        targetId: String(body?.targetId || ""),
        id: String(body?.id || ""),
        path: requestedPath,
        title: String(body?.title || ""),
        caseSensitive: body?.caseSensitive === true,
      });
      if (!Array.isArray(data?.mentions)) {
        throw Object.assign(new Error("Kernel virtual-reference response is missing mentions"), { statusCode: 502 });
      }
      let target = null;
      if (data.target) {
        const mapped = mapNote(data.target, "Kernel virtual-reference target");
        target = { id: String(data.target.id || ""), title: String(data.target.title || ""), file: mapped.file, path: mapped.path };
      }
      const mentions = data.mentions.map((raw) => {
        const note = raw?.note ? mapNote(raw.note, "Kernel virtual-reference mention") : undefined;
        const path = note?.path || mapVirtualMentionPath(raw?.path);
        return {
          ...raw,
          sourceId: String(raw.sourceId || note?.id || note?.key || ""),
          sourceTitle: String(raw.sourceTitle || note?.title || ""),
          file: note?.file || "",
          path,
          keywords: Array.isArray(raw.keywords) ? raw.keywords.map(String) : [],
          note,
        };
      });
      return {
        ...data,
        type: "virtual-references",
        evaluationSource: String(data.evaluationSource || "noema-aho-corasick"),
        target,
        mentions,
      };
    },
    async read(file) {
      const path = pathFor(file);
      if (!path) throw Object.assign(new Error("File is outside the kernel Markdown box"), { statusCode: 403 });
      const data = await post("/api/noema/markdown/loadDoc", { notebook, path, includeBlocks: false });
      if (typeof data.markdown !== "string") {
        throw Object.assign(new Error("Kernel load response is missing Markdown source"), { statusCode: 502 });
      }
      return {
        file: String(file),
        content: data.markdown,
        mtimeMs: Number(data.mtimeMs) || 0,
        size: Number(data.size) || 0,
        version: String(data.version || ""),
      };
    },
    async resolveBlock(id) {
      const canonicalId = String(id || "").trim().toLowerCase();
      if (!isBlockReferenceId(canonicalId)) {
        throw Object.assign(new Error("Block reference ID is invalid"), { statusCode: 400 });
      }
      const data = await post("/api/noema/markdown/resolveBlock", { id: canonicalId });
      const returnedId = String(data.id || "").trim().toLowerCase();
      const returnedNotebook = String(data.notebook || "").trim();
      const returnedPath = String(data.path || "").trim();
      if (returnedId !== canonicalId || returnedNotebook !== notebook || !returnedPath.startsWith("/")) {
        throw Object.assign(new Error("Kernel block location does not match the registered Markdown box"), { statusCode: 502 });
      }
      const file = resolve(root, ...returnedPath.slice(1).split("/").filter(Boolean));
      if (pathFor(file) !== returnedPath) {
        throw Object.assign(new Error("Kernel block location escapes the registered Markdown box"), { statusCode: 502 });
      }
      let canonicalFile = "";
      try {
        canonicalFile = realpathSync.native(file);
        if (!statSync(canonicalFile).isFile()) throw new Error("not a regular file");
      } catch {
        throw Object.assign(new Error("Kernel block location is not a readable Markdown file"), { statusCode: 502 });
      }
      return {
        id: canonicalId,
        notebook,
        path: returnedPath,
        file: canonicalFile,
        line: Math.max(1, Number.isInteger(Number(data.line)) ? Number(data.line) : 1),
        blockType: String(data.type || ""),
      };
    },
    async write({ file, content, expectedVersion = "", force = false }) {
      const path = pathFor(file);
      if (!path) throw Object.assign(new Error("File is outside the kernel Markdown box"), { statusCode: 403 });
      const source = String(content ?? "");
      const request = { notebook, path, markdown: source };
      if (String(expectedVersion || "")) request.expectedVersion = String(expectedVersion);
      if (force === true) request.force = true;
      const data = await post("/api/noema/markdown/saveDoc", request);
      if (typeof data.markdown !== "string") {
        throw Object.assign(new Error("Kernel save response is missing Markdown source"), { statusCode: 502 });
      }
      if (data.conflict === true) {
        return {
          ok: false,
          conflict: true,
          file: String(file),
          content: data.markdown,
          mtimeMs: Number(data.mtimeMs) || 0,
          size: Number(data.size) || 0,
          version: String(data.version || ""),
        };
      }
      if (data.rejected === true) {
        return {
          ok: false,
          conflict: false,
          file: String(file),
          content: data.markdown,
          message: String(data.message || "Kernel rejected Markdown save"),
          mtimeMs: Number(data.mtimeMs) || 0,
          size: Number(data.size) || 0,
          version: String(data.version || ""),
        };
      }
      const saved = data.markdown;
      if (saved !== source) {
        throw Object.assign(new Error("Kernel changed Markdown source bytes while saving"), { statusCode: 502 });
      }
      return {
        ok: true,
        file: String(file),
        content: saved,
        blocks: data.blocks || [],
        mtimeMs: Number(data.mtimeMs) || 0,
        size: Number(data.size) || 0,
        version: String(data.version || ""),
      };
    },
    async writeChanges({ file, changes, expectedVersion = "", force = false }) {
      const path = pathFor(file);
      if (!path)
        throw Object.assign(new Error("File is outside the kernel Markdown box"), {
          statusCode: 403,
        });
      if (!expectedVersion) {
        throw Object.assign(new Error("Incremental Markdown save requires a base version"), {
          statusCode: 400,
        });
      }
      const request = { notebook, path, expectedVersion: String(expectedVersion), changes };
      if (force === true) request.force = true;
      const data = await post("/api/noema/markdown/applyChanges", request);
      if (data.conflict === true || data.rejected === true) {
        return {
          ok: false,
          conflict: data.conflict === true,
          rejected: data.rejected === true,
          file: String(file),
          content: typeof data.markdown === "string" ? data.markdown : "",
          message: String(
            data.message ||
              (data.conflict ? "File changed on disk" : "Kernel rejected Markdown save"),
          ),
          mtimeMs: Number(data.mtimeMs) || 0,
          size: Number(data.size) || 0,
          version: String(data.version || ""),
        };
      }
      if (typeof data.version !== "string" || !data.version) {
        throw Object.assign(new Error("Kernel incremental Markdown response has no version"), {
          statusCode: 502,
        });
      }
      return {
        ok: true,
        file: String(file),
        mtimeMs: Number(data.mtimeMs) || 0,
        size: Number(data.size) || 0,
        version: String(data.version || ""),
      };
    },
    async mutateMeta(body = {}, action = "") {
      const file = String(body.file || "");
      const path = pathFor(file);
      if (!path) throw Object.assign(new Error("File is outside the kernel Markdown box"), { statusCode: 403 });
      const request = { notebook, path, action: String(action || body.action || "") };
      if (typeof body.content === "string") request.markdown = body.content;
      if (typeof body.expectedVersion === "string" && body.expectedVersion) request.expectedVersion = body.expectedVersion;
      for (const key of ["title", "kind", "project"]) {
        if (Object.prototype.hasOwnProperty.call(body, key)) request[key] = String(body[key] ?? "");
      }
      if (Object.prototype.hasOwnProperty.call(body, "tags")) {
        if (!Array.isArray(body.tags)) {
          throw Object.assign(new Error("Metadata tags must be an array"), { statusCode: 400 });
        }
        request.tags = body.tags.map((tag) => String(tag));
      }
      const data = await post("/api/noema/markdown/mutateMeta", request);
      if (typeof data.markdown !== "string" || data.source !== "kernel-meta") {
        throw Object.assign(new Error("Kernel metadata response is incomplete"), { statusCode: 502 });
      }
      return data;
    },
    async move({ file, target, directory = false }) {
      const fromPath = directory ? kernelBoxPath(root, file) : pathFor(file);
      const toPath = directory ? kernelBoxPath(root, target) : pathFor(target);
      if (!fromPath || !toPath) {
        throw Object.assign(new Error("Markdown move must stay inside the kernel box"), { statusCode: 403 });
      }
      const endpoint = directory ? "/api/noema/markdown/movePath" : "/api/noema/markdown/moveDoc";
      const data = await post(endpoint, { notebook, fromPath, toPath });
      if (data.fromPath !== fromPath || data.toPath !== toPath || (directory ? data.directory !== true || !Array.isArray(data.documents) : !data.id)) {
        throw Object.assign(new Error("Kernel move response does not match the requested paths"), { statusCode: 502 });
      }
      return { ok: true, file: String(target), oldFile: String(file), ...data };
    },
  };
}
