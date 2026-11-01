// Placed file visits share the Emacs/CLI placement owner and return its actual
// result. Legacy page-open events and Markdown clones keep their own path.
const placements = new Set(["here", "other", "left", "right", "above", "below", "frame"]);
const bad = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };

export async function openPlacedFile(body, { resolveFile, request }) {
  const { file, placement, line = 1, col = 0, noFocus = false } = body;
  if (typeof file !== "string" || !file.trim()) bad("A file path is required");
  if (!placements.has(placement)) bad("Unknown placement; use here, other, left, right, above, below or frame");
  if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(col) || col < 0)
    bad("line must be 1-based and col must be 0-based");
  if (typeof noFocus !== "boolean") bad("noFocus must be a boolean");
  if (body.newWindow === true || body.tag) bad("Placed visits use line/col; omit newWindow and tag");
  return request("noema.open-file", { file: resolveFile(file), placement, line, col, noFocus });
}
