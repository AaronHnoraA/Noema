import { parseOrgEnvIdentityTitle } from "./block-identity.mjs";

function diagnostic(kind, message) {
  return { kind, message };
}

/**
 * Parse Noema's portable query-embed carrier.
 *
 * Canonical, readable form:
 *   #+begin embed Recent claims {#UUIDv7}
 *   sql: SELECT ...
 *   #+end embed
 *
 * The migration-plan spelling remains accepted as a compact form:
 *   #+begin embed :sql SELECT ...
 *   #+end embed
 */
export function parseEmbedQuerySpec(title = "", body = "") {
  const identity = parseOrgEnvIdentityTitle("embed", title);
  const rawTitle = String(identity.title || "").trim();
  const rawBody = String(body || "").trim();
  const inline = /^:sql(?:\s+([\s\S]+))?$/i.exec(rawTitle);
  const diagnostics = [];
  let statement = "";
  let displayTitle = rawTitle;

  if (inline) {
    displayTitle = "";
    statement = String(inline[1] || "").trim();
    if (rawBody) {
      diagnostics.push(diagnostic("ambiguous-query", "Inline :sql and a fenced query body cannot be used together"));
      statement = "";
    }
  } else {
    statement = rawBody.replace(/^:?sql\s*:\s*/i, "").trim();
  }

  if (!statement && diagnostics.length === 0) {
    diagnostics.push(diagnostic("missing-query", "Embed query requires a SELECT or WITH statement"));
  } else if (statement && !/^(?:select|with)\b/i.test(statement)) {
    diagnostics.push(diagnostic("invalid-query", "Embed query must start with SELECT or WITH"));
    statement = "";
  }

  const heading = Number(identity.attrs?.heading ?? 0);
  const headingMode = Number.isInteger(heading) && heading >= 0 && heading <= 2 ? heading : 0;
  if (identity.attrs?.heading != null && headingMode !== heading) {
    diagnostics.push(diagnostic("invalid-heading", "heading must be 0, 1, or 2"));
  }
  const breadcrumbValue = String(identity.attrs?.breadcrumb ?? "true").toLowerCase();
  const breadcrumb = breadcrumbValue !== "false" && breadcrumbValue !== "0" && breadcrumbValue !== "no";

  return {
    title: displayTitle || "Embedded query",
    statement,
    blockId: String(identity.blockId || ""),
    headingMode,
    breadcrumb,
    diagnostics,
  };
}
