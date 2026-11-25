import type MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import type { AttrMap } from "../shared/layout-attrs.mjs";
import { headingLabel } from "./document-tabs.ts";
import { documentViewSourceKey } from "./document-view.ts";
import { sequenceDiff, wordDiff } from "./word-diff.ts";

export const documentDiffModes = ["auto", "split", "unified"] as const;
type Side = "before" | "after";
type DiffLine = { number: number; text: string };
type DiffRow = { before?: DiffLine; after?: DiffLine; same?: boolean };

export function documentDiffSides(md: MarkdownIt, body: string): Array<{ fence: Token; label: string }> | null {
  const environment = {};
  const tokens = md.parse(body, environment);
  const sides: Array<{ fence: Token; label: string }> = [];
  let label = "";
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type === "heading_open" && !label && tokens[index + 3]?.type === "fence") {
      label = headingLabel(md, tokens[index + 1]!, environment);
      index += 2;
    } else if (token.type === "fence") {
      sides.push({ fence: token, label });
      label = "";
    } else return null;
  }
  return sides.length === 2 ? sides : null;
}

function lineRows(before: string[], after: string[]): DiffRow[] | null {
  const changes = sequenceDiff(before, after);
  if (!changes) return null;
  const rows: DiffRow[] = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  let beforeNumber = 1;
  let afterNumber = 1;
  const flush = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index++) {
      rows.push({ before: removed[index], after: added[index] });
    }
    removed = [];
    added = [];
  };
  for (const { kind, values } of changes) {
    if (kind === "same") {
      flush();
      for (const text of values) rows.push({ same: true, before: { text, number: beforeNumber++ }, after: { text, number: afterNumber++ } });
    } else if (kind === "del") {
      for (const text of values) removed.push({ text, number: beforeNumber++ });
    } else {
      for (const text of values) added.push({ text, number: afterNumber++ });
    }
  }
  flush();
  return rows;
}

export function renderDocumentDiff(md: MarkdownIt, title: string, body: string, attrs: AttrMap, interactive: boolean): string | null {
  const sides = documentDiffSides(md, body);
  if (!sides) return null;
  const [before, after] = sides;
  const escape = md.utils.escapeHtml;
  const beforeLabel = attrs.before || before!.label || "Before";
  const afterLabel = attrs.after || after!.label || "After";
  const fallback = () => `<div class="noema-diff-fallback"><div>${escape(beforeLabel)}</div><pre><code>${escape(before!.fence.content)}</code></pre>`
    + `<div>${escape(afterLabel)}</div><pre><code>${escape(after!.fence.content)}</code></pre></div>`;
  if (before!.fence.content.length + after!.fence.content.length > 250_000) return fallback();
  const lines = (text: string) => text ? text.replace(/\n$/u, "").split("\n") : [];
  const originalBefore = lines(before!.fence.content);
  const originalAfter = lines(after!.fence.content);
  if (originalBefore.length + originalAfter.length > 4_000) return fallback();
  const rows = lineRows(originalBefore, originalAfter);
  if (!rows) return fallback();

  const beforeStart = before!.fence.map![0];
  const afterStart = after!.fence.map![0];
  const formatted = rows.map((row) => {
    const changes = row.before && row.after && !row.same ? wordDiff(row.before.text, row.after.text) : null;
    const cell = (side: Side): string => {
      const line = row[side];
      if (!line) return `<div class="noema-diff-cell" data-diff-side="${side}" data-diff-state="empty"></div>`;
      const base = side === "before" ? beforeStart : afterStart;
      const tag = side === "before" ? "del" : "ins";
      const text = changes?.filter(({ kind }) => kind === "same" || kind === tag).map(({ kind, text }) =>
        kind === "same" ? escape(text) : `<${tag}>${escape(text)}</${tag}>`).join("") ?? escape(line.text);
      const state = row.same ? "same" : side === "before" ? "removed" : "added";
      const marker = row.same ? "" : side === "before" ? "−" : "+";
      const location = interactive ? ` data-diff-line="${base + line.number}"` : "";
      const counterpart = row.same && side === "before" ? `<span class="noema-diff-other-number">${row.after?.number ?? ""}</span>` : "";
      return `<div class="noema-diff-cell" data-diff-side="${side}" data-diff-state="${state}"${location}>`
        + `<span class="noema-diff-number">${line.number}</span>${counterpart}<span class="noema-diff-marker">${marker}</span><code>${text}</code></div>`;
    };
    return `<div class="noema-diff-row">${cell("before")}${cell("after")}</div>`;
  }).join("");

  const mode = documentDiffModes.find((candidate) => candidate === attrs.view?.toLowerCase()) || "auto";
  const identity = interactive ? ` data-view-kind="diff" data-view-source="${documentViewSourceKey("diff", title, body)}"` : "";
  const controls = interactive ? '<div class="noema-diff-toolbar">'
    + '<div class="noema-diff-modes"><button type="button" data-diff-mode="auto">Auto</button>'
    + '<button type="button" data-diff-mode="split" title="Side by side">Split</button><button type="button" data-diff-mode="unified">Unified</button></div>'
    + '<span class="noema-diff-status"></span></div>' : "";
  const labels = `<div class="noema-diff-labels">${(["before", "after"] as const).map((side) => {
    const label = side === "before" ? beforeLabel : afterLabel;
    const copy = interactive ? `<button type="button" data-diff-copy="${side}">Copy</button>` : "";
    return `<div><span>${escape(label)}</span>${copy}</div>`;
  }).join("")}</div>`;
  const copies = interactive ? `<template data-diff-copy="before">${escape(before!.fence.content)}</template>`
    + `<template data-diff-copy="after">${escape(after!.fence.content)}</template>` : "";
  const digits = String(Math.max(originalBefore.length, originalAfter.length)).length;
  return `<div class="noema-document-diff" data-diff-mode="${mode}" style="--diff-digits:${digits}"${identity}>${controls}${labels}${formatted}${copies}</div>`;
}
