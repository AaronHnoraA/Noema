const TABSTOP_RE = /\$(?:\{(\d+)(?=[:|}])|(\d+))/g;
const BARE_TABSTOP_RE = /\$(\d+)|\$\{(\d+)\}/g;

function escapedAt(source, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor--) slashes++;
  return slashes % 2 === 1;
}

function bracedTabstopEnd(source, start) {
  let depth = 1;
  for (let cursor = start + 2; cursor < source.length; cursor++) {
    if (escapedAt(source, cursor)) continue;
    if (source[cursor] === "{") depth++;
    else if (source[cursor] === "}" && --depth === 0) return cursor + 1;
  }
  return source.length;
}

function tabstopTokens(source) {
  const tokens = [];
  for (const match of source.matchAll(TABSTOP_RE)) {
    if (escapedAt(source, match.index)) continue;
    const index = Number(match[1] ?? match[2]);
    const braced = match[1] !== undefined;
    const marker = braced ? source[match.index + match[0].length] : "";
    const emptyDefault = marker === ":" && source[match.index + match[0].length + 1] === "}";
    tokens.push({
      index,
      start: match.index,
      end: braced ? bracedTabstopEnd(source, match.index) : match.index + match[0].length,
      kind: emptyDefault ? "empty-default" : marker === ":" ? "default" : marker === "|" ? "choice" : "bare",
    });
  }
  return tokens;
}

function bareTabstopTokens(source) {
  const tokens = [];
  for (const match of source.matchAll(BARE_TABSTOP_RE)) {
    if (escapedAt(source, match.index)) continue;
    tokens.push({
      index: Number(match[1] ?? match[2]),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
}

function defaultForTabstop(index) {
  return index <= 26 ? String.fromCharCode(96 + index) : `x${index}`;
}

function replaceRanges(source, replacements) {
  let result = source;
  for (const replacement of [...replacements].sort((a, b) => b.from - a.from)) {
    result = result.slice(0, replacement.from) + replacement.value + result.slice(replacement.to);
  }
  return result;
}

/**
 * Canonical TeX/YAS policy:
 * - each non-zero group has a visible default on its first occurrence;
 * - repeated occurrences stay mirrors;
 * - each snippet has one explicit final `$0` stop.
 */
export function normalizeTexSnippetBody(body) {
  let result = String(body ?? "");
  let tokens = tabstopTokens(result);

  // Only the first occurrence owns a default/choice. Later occurrences are
  // mirrors, even when an imported TextMate/YAS source redundantly repeats a
  // default. Collapse outer mirrors first so nested tokens inside a redundant
  // default do not produce overlapping edits.
  const mirrorReplacements = [];
  for (const index of [...new Set(tokens.map((token) => token.index))]) {
    if (index === 0) continue;
    const occurrences = tokens.filter((token) => token.index === index);
    for (const mirror of occurrences.slice(1)) {
      if (mirror.kind !== "bare") {
        mirrorReplacements.push({ from: mirror.start, to: mirror.end, value: `$${index}` });
      }
    }
  }
  const outerMirrorReplacements = mirrorReplacements.filter((replacement) => (
    !mirrorReplacements.some((outer) => outer !== replacement
      && outer.from <= replacement.from && replacement.to <= outer.to)
  ));
  result = replaceRanges(result, outerMirrorReplacements);
  tokens = tabstopTokens(result);

  if (!tokens.some((token) => token.index === 0)) {
    const nonzero = tokens.filter((token) => token.index > 0);
    const indexes = [...new Set(nonzero.map((token) => token.index))];
    const bare = bareTabstopTokens(result).filter((token) => token.index > 0);
    const last = bare.at(-1);
    const trimmedEnd = result.trimEnd().length;
    const occurrences = last
      ? nonzero.filter((token) => token.index === last.index).length
      : 0;
    const oldStyleFinal = Boolean(
      last
      && indexes.length > 1
      && last.end === trimmedEnd
      && last.index === Math.max(...indexes)
      && occurrences === 1,
    );
    if (oldStyleFinal && last) {
      result = replaceRanges(result, [{ from: last.start, to: last.end, value: "$0" }]);
    } else {
      result += "$0";
    }
  }

  tokens = tabstopTokens(result);
  const replacements = [];
  for (const index of [...new Set(tokens.map((token) => token.index))].sort((a, b) => a - b)) {
    if (index === 0) continue;
    const occurrences = tokens.filter((token) => token.index === index);
    const primary = occurrences[0];
    if (primary?.kind === "default" || primary?.kind === "choice") continue;
    const first = primary?.kind === "empty-default"
      ? primary
      : bareTabstopTokens(result).find((token) => token.index === index && token.start === primary?.start);
    if (first && primary) {
      replacements.push({
        from: first.start,
        to: first.end,
        value: `\${${index}:${defaultForTabstop(index)}}`,
      });
    }
  }
  return replaceRanges(result, replacements);
}

export function inspectTexSnippetBody(body) {
  const tokens = tabstopTokens(String(body ?? ""));
  const diagnostics = [];
  const finalStops = tokens.filter((token) => token.index === 0);
  if (finalStops.length !== 1) diagnostics.push(`expected one final $0, found ${finalStops.length}`);

  const indexes = [...new Set(tokens.map((token) => token.index).filter((index) => index > 0))]
    .sort((a, b) => a - b);
  let mirrors = 0;
  for (const index of indexes) {
    const occurrences = tokens.filter((token) => token.index === index);
    mirrors += Math.max(0, occurrences.length - 1);
    const first = occurrences[0];
    if (first?.kind !== "default" && first?.kind !== "choice") {
      diagnostics.push(`tabstop $${index} has no primary default`);
    }
    if (occurrences.slice(1).some((token) => token.kind !== "bare")) {
      diagnostics.push(`tabstop $${index} has a non-bare mirror`);
    }
  }
  return { diagnostics, groups: indexes.length, mirrors };
}
