export function isMarkdownFilePath(file) {
  return /\.(?:md|markdown)$/i.test(String(file || "").trim());
}

export function desktopDropDisposition(files, forceAttachment = false) {
  const paths = Array.from(files || [])
    .map((file) => String(file || "").trim())
    .filter(Boolean);
  if (!forceAttachment && paths.length > 0 && paths.every(isMarkdownFilePath)) {
    return { type: "open", paths };
  }
  return { type: "insert", paths };
}
