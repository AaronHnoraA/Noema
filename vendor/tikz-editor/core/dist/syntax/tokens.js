export const PATH_KEYWORDS = new Set([
    "--",
    "-|",
    "|-",
    "..",
    "edge",
    "at",
    "bend",
    "controls",
    "and",
    "cycle",
    "rectangle",
    "circle",
    "ellipse",
    "arc",
    "grid",
    "plot",
    "coordinates",
    "parabola",
    "sin",
    "cos"
]);
export function classifyPathKeyword(node, source) {
    const raw = source.slice(node.from, node.to).trim().toLowerCase();
    if (PATH_KEYWORDS.has(raw)) {
        return raw;
    }
    return null;
}
