/** Local review blocks replace the exact Markdown lines at their position. */
export function scanEdiffBlocks(value) {
  const source = String(value ?? "");
  const lines = [];
  for (const match of source.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!match[0]) break;
    const raw = match[0];
    const from = match.index;
    const line = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    lines.push({ text: line, from, to: from + line.length, end: from + raw.length });
  }
  const blocks = [];
  let fence = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].text;
    if (fence) {
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = "";
      continue;
    }
    const fenced = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenced) { fence = fenced[1]; continue; }
    const open = line.match(/^#\+begin ediff(?:[ \t]+(.*?))?[ \t]*$/i);
    if (!open) continue;
    let close = i + 1;
    while (close < lines.length && !/^#\+end ediff[ \t]*$/i.test(lines[close].text)) close++;
    if (close >= lines.length) continue;
    let body = i + 1;
    let rejected = false;
    const comments = [];
    let error;
    if (lines[body]?.text === "@@ediff-status rejected") { rejected = true; body++; }
    while (body < close && lines[body].text.startsWith("@@ediff-comment ")) {
      try {
        const comment = JSON.parse(lines[body].text.slice("@@ediff-comment ".length));
        if (typeof comment !== "string") throw new Error("Invalid comment");
        comments.push(comment);
      } catch { error = "Invalid comment JSON"; }
      body++;
    }
    const changes = [];
    for (let j = body; j < close; j++) {
      const raw = lines[j].text;
      if (raw === "\\ No newline at end of file") {
        const previous = changes.at(-1);
        if (!previous || previous.noNewline) error ||= "Misplaced no-newline marker";
        else previous.noNewline = true;
      } else if (/^[ +\-]/.test(raw)) {
        changes.push({ kind: raw[0], text: raw.slice(1), noNewline: false });
      } else error ||= `Invalid diff line: ${raw}`;
    }
    if (!changes.some((item) => item.kind === "+" || item.kind === "-")) error ||= "A review block needs an addition or deletion";
    const oldLines = changes.filter((item) => item.kind !== "+");
    const newLines = changes.filter((item) => item.kind !== "-");
    const end = lines[close].end;
    for (const side of [oldLines, newLines]) {
      const marker = side.findIndex((item) => item.noNewline);
      if (marker >= 0 && (marker !== side.length - 1 || end !== source.length))
        error ||= "No-newline marker must describe the final line of this note";
    }
    blocks.push({
      from: lines[i].from, to: lines[close].to, end,
      title: open[1] || "Proposed edit", rejected, comments, changes,
      oldLines, newLines, error,
    });
    i = close;
  }
  return blocks;
}

export function ediffSide(block, side) {
  const lines = side === "old" ? block.oldLines : block.newLines;
  if (!lines.length) return "";
  return lines.map((line) => line.text).join("\n")
    + (!lines.at(-1).noNewline && block.end > block.to ? "\n" : "");
}

/** Resolve valid proposals to their old side for indexing and export. */
export function approvedEdiffMarkdown(value) {
  const source = String(value ?? "");
  const blocks = scanEdiffBlocks(source);
  let result = "";
  let at = 0;
  for (const block of blocks) {
    result += source.slice(at, block.from);
    result += block.error ? source.slice(block.from, block.end) : ediffSide(block, "old");
    at = block.end;
  }
  return result + source.slice(at);
}
