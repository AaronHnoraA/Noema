const TIKZJAX_CSS = "https://tikzjax.com/v1/fonts.css";
const TIKZJAX_JS = "https://tikzjax.com/v1/tikzjax.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tikzScriptText(value: string): string {
  return value.replace(/<\/script/gi, "<\\/script");
}

export function stripTikzComments(source: string): string {
  return String(source || "")
    .split(/\r?\n/)
    .map((line) => {
      for (let i = 0; i < line.length; i++) {
        if (line[i] !== "%") continue;
        let slashCount = 0;
        for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) slashCount++;
        if (slashCount % 2 === 0) return line.slice(0, i).trimEnd();
      }
      return line;
    })
    .join("\n");
}

export function normalizeTikzSource(source: string): string {
  const trimmed = stripTikzComments(source).trim();
  if (!trimmed) return "";
  if (/\\documentclass\b|\\begin\s*\{\s*document\s*\}/.test(trimmed)) return trimmed;
  if (/\\begin\s*\{\s*tikzpicture\s*\}/.test(trimmed)) return trimmed;
  return `\\begin{tikzpicture}\n${trimmed}\n\\end{tikzpicture}`;
}

export function tikzSrcdoc(source: string): string {
  const tikz = tikzScriptText(normalizeTikzSource(source));
  return `<!doctype html>
<html>
<head>
<meta charset='utf-8'>
<meta name='viewport' content='width=device-width, initial-scale=1'>
<link rel='stylesheet' href='${TIKZJAX_CSS}'>
<script defer src='${TIKZJAX_JS}'></script>
<style>
html,body{margin:0;width:100%;height:100%;background:transparent;color:#1f2937}
body{box-sizing:border-box;display:grid;place-items:center;padding:10px;overflow:hidden}
svg{display:block;max-width:100%;max-height:100%;height:auto}
</style>
</head>
<body>
<script type='text/tikz'>${tikz}</script>
</body>
</html>`;
}

export function renderTikzIframe(source: string, className = "aaronnote-tikz-embed"): string {
  const srcdoc = escapeHtml(tikzSrcdoc(source));
  return [
    `<iframe class="${escapeHtml(className)} aaronnote-visual-embed"`,
    'title="TikZ diagram"',
    'loading="lazy"',
    'sandbox="allow-scripts"',
    'referrerpolicy="no-referrer"',
    `srcdoc="${srcdoc}"></iframe>`,
  ].join(" ");
}
