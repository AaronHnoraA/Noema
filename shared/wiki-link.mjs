const WIKI_LINK_RE = /(?<!\\)\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]/g;

export function wikiHrefForTarget(value) {
  const target = String(value || "").trim();
  if (!target) return "";
  // `formatStableWikiLink` writes `[[roam://<id>#<frag>|Label]]`, so a target
  // can already be a canonical roam URL.  Wrapping it again produced
  // `roam://wiki/roam%3A%2F%2F<id>%23<frag>`, which resolves to nothing —
  // the stable form round-tripped into a dangling link.
  if (/^roam:\/\//i.test(target)) return target;
  return `roam://wiki/${encodeURIComponent(target)}`;
}

export function scanWikiLinks(value, offset = 0) {
  const source = String(value || "");
  const links = [];
  WIKI_LINK_RE.lastIndex = 0;
  let match;
  while ((match = WIKI_LINK_RE.exec(source)) !== null) {
    const target = String(match[1] || "").trim();
    const explicitLabel = match[2] != null;
    const label = String(explicitLabel ? match[2] : match[1] || "").trim();
    if (!target || !label) continue;
    const rawTarget = String(match[1] || "");
    const rawLabel = explicitLabel ? String(match[2] || "") : rawTarget;
    const from = offset + match.index;
    const to = from + match[0].length;
    const targetRawFrom = from + 2;
    const targetFrom = targetRawFrom + rawTarget.indexOf(target);
    const targetTo = targetFrom + target.length;
    const pipe = explicitLabel ? targetRawFrom + rawTarget.length : -1;
    const labelRawFrom = explicitLabel ? pipe + 1 : targetRawFrom;
    const labelFrom = labelRawFrom + rawLabel.indexOf(label);
    const labelTo = labelFrom + label.length;
    links.push({
      from,
      to,
      target,
      label,
      href: wikiHrefForTarget(target),
      targetFrom,
      targetTo,
      labelFrom,
      labelTo,
      pipe,
      explicitLabel,
    });
  }
  return links;
}

export function wikiLinkAt(value, position, offset = 0) {
  const pos = Number(position);
  if (!Number.isFinite(pos)) return null;
  return scanWikiLinks(value, offset).find((link) => pos >= link.from && pos <= link.to) || null;
}

export function stableWikiTarget(pageId, fragmentValue = "") {
  const id = String(pageId || "").trim();
  const fragment = String(fragmentValue || "").trim().replace(/^#/, "");
  return id ? `roam://${id}${fragment ? `#${encodeURIComponent(fragment)}` : ""}` : "";
}

export function formatStableWikiLink(pageId, label, fragment = "") {
  const target = stableWikiTarget(pageId, fragment);
  const text = String(label || "").trim();
  if (!target || !text) return "";
  return `[[${target}|${text}]]`;
}

/** Split the page part and optional `#fragment` without changing either grammar. */
export function splitWikiFragmentTarget(value) {
  const target = String(value || "").trim();
  const hash = target.indexOf("#");
  if (hash < 0) return { pageTarget: target, fragment: "" };
  let fragment = target.slice(hash + 1).trim();
  try { fragment = decodeURIComponent(fragment); } catch {}
  return { pageTarget: target.slice(0, hash).trim(), fragment };
}

export function normalizeWikiNamespace(value) {
  return String(value || "").normalize("NFKC").trim().split("/")
    .map((part) => part.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("/");
}

export function qualifiedWikiTitle(namespace, title) {
  const scope = normalizeWikiNamespace(namespace);
  const name = String(title || "").normalize("NFKC").trim();
  return scope && name ? `${scope}:${name}` : name;
}

export function splitQualifiedWikiTarget(value, knownNamespaces = []) {
  const target = String(value || "").normalize("NFKC").trim();
  const colon = target.indexOf(":");
  if (colon <= 0 || /^roam:\/\//i.test(target)) return { target, namespace: "", title: target, qualified: false };
  const namespace = normalizeWikiNamespace(target.slice(0, colon));
  const title = target.slice(colon + 1).trim();
  void knownNamespaces;
  return namespace && title
    ? { target, namespace, title, qualified: true }
    : { target, namespace: "", title: target, qualified: false };
}
