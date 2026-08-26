// Shared-host transport for the Go-owned deterministic portion of LaTeX export.
// Pandoc/TeX/Codex process supervision remains in the shared Node host.

function citationKeyObject(value) {
  if (value instanceof Map) return Object.fromEntries(value);
  return value && typeof value === "object" ? { ...value } : {};
}

export function createKernelLatexProvider({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base || typeof fetchImpl !== "function") {
    throw new Error("Kernel LaTeX provider requires baseUrl and fetch");
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
      const error = new Error(String(payload?.msg || `kernel request failed with HTTP ${response.status}`));
      error.statusCode = response.ok ? 502 : response.status;
      throw error;
    }
    return payload.data;
  }

  return {
    async prepare(markdown, options = {}) {
      const data = await post("/api/noema/latex/preparePandoc", {
        markdown: String(markdown ?? ""),
        rules: options.rules && typeof options.rules === "object" ? options.rules : {},
        citationKeyMap: citationKeyObject(options.citationKeyMap),
      });
      if (typeof data.markdown !== "string" || !data.meta || !data.features) {
        throw Object.assign(new Error("Kernel LaTeX prepare response is incomplete"), { statusCode: 502 });
      }
      return {
        meta: data.meta,
        markdown: data.markdown,
        warnings: Array.isArray(data.warnings) ? data.warnings.map(String) : [],
        features: {
          usesSideComment: data.features.usesSideComment === true,
          usesTikz: data.features.usesTikz === true,
        },
      };
    },
    async metadata(markdown) {
      const data = await post("/api/noema/latex/extractMetadata", { markdown: String(markdown ?? "") });
      if (!data.meta || typeof data.meta !== "object") {
        throw Object.assign(new Error("Kernel LaTeX metadata response is incomplete"), { statusCode: 502 });
      }
      return { ...data.meta };
    },
    async postprocess(latex) {
      const data = await post("/api/noema/latex/postprocessPandoc", { latex: String(latex ?? "") });
      if (typeof data.latex !== "string") {
        throw Object.assign(new Error("Kernel LaTeX postprocess response is incomplete"), { statusCode: 502 });
      }
      return data.latex;
    },
    async planTemplate(template, allowedKeys = []) {
      const data = await post("/api/noema/latex/planTemplate", {
        template: String(template ?? ""),
        allowedKeys: Array.from(new Set((allowedKeys || []).map(String))),
      });
      if (!Array.isArray(data.segments) || !Array.isArray(data.placeholders)
          || data.segments.length !== data.placeholders.length + 1) {
        throw Object.assign(new Error("Kernel LaTeX template plan is incomplete"), { statusCode: 502 });
      }
      return {
        segments: data.segments.map(String),
        placeholders: data.placeholders.map(String),
      };
    },
    renderTemplate(plan, vars = {}) {
      if (!Array.isArray(plan?.segments) || !Array.isArray(plan?.placeholders)
          || plan.segments.length !== plan.placeholders.length + 1) {
        throw new Error("Invalid kernel LaTeX template plan");
      }
      let output = String(plan.segments[0] || "");
      for (let index = 0; index < plan.placeholders.length; index += 1) {
        const key = String(plan.placeholders[index] || "");
        if (!Object.prototype.hasOwnProperty.call(vars, key)) {
          throw new Error(`Missing LaTeX template value: ${key}`);
        }
        output += String(vars[key] ?? "") + String(plan.segments[index + 1] || "");
      }
      return output;
    },
  };
}
