import {
  KP_FORCED_BREAK,
  type KpBox,
  type KpGlue,
  type KpItem,
  type KpPenalty,
} from "./knuth-plass.ts";

export type MixedCjkMeasure = (text: string, kind: "prose" | "code") => number;

export type MixedCjkOptions = {
  from?: number;
  em: number;
  measure: MixedCjkMeasure;
  /** Source offsets immediately after a Markdown hard break. */
  hardBreakEnds?: ReadonlySet<number>;
  /** Source ranges hidden by Markdown syntax, while preserving absolute offsets. */
  hiddenRanges?: readonly { from: number; to: number }[];
  /** Split otherwise-rigid Latin runs wider than this with emergency penalties. */
  emergencyLineWidth?: number;
};

const graphemeSegmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });
const HAN = /^\p{Script=Han}$/u;
const LATIN_OR_NUMBER = /^[\p{Script=Latin}\p{Number}]$/u;
const SPACE = /^[\t \u00a0]$/u;
const OPEN_PUNCTUATION = new Set([..."（《〈「『【〔〖［｛“‘﹁﹃"]);
const CLOSE_PUNCTUATION = new Set([..."，。、；：！？）》〉」』】〕〗］｝”’﹂﹄…—"]);
const LATIN_OPEN = new Set(["(", "[", "{", "“", "‘"]);
const LATIN_CLOSE = new Set([")", "]", "}", ".", ",", ";", ":", "!", "?", "%", "”", "’"]);
const LATIN_JOINER = new Set([...".,:/?#@&=+~%'"]);
const NUMERIC_PREFIX = new Set([..."$¥￥£€₩₹₽+-±"]);
const NUMERIC_SUFFIX = new Set(["%", "‰", "‱", "°", "℃", "℉", "₫"]);

type Cluster = {
  text: string;
  from: number;
  to: number;
  kind: "han" | "latin" | "space" | "open" | "close" | "other" | "newline";
};

function kindFor(text: string): Cluster["kind"] {
  if (text === "\n") return "newline";
  if (SPACE.test(text)) return "space";
  if (HAN.test(text)) return "han";
  if (LATIN_OR_NUMBER.test(text) || text === "_" || text === "-") return "latin";
  if (OPEN_PUNCTUATION.has(text) || LATIN_OPEN.has(text)) return "open";
  if (CLOSE_PUNCTUATION.has(text) || LATIN_CLOSE.has(text)) return "close";
  return "other";
}

function clustersFor(text: string, sourceFrom: number): Cluster[] {
  return [...graphemeSegmenter.segment(text)].map((segment) => ({
    text: segment.segment,
    from: sourceFrom + segment.index,
    to: sourceFrom + segment.index + segment.segment.length,
    kind: kindFor(segment.segment),
  }));
}

function box(cluster: Cluster, measure: MixedCjkMeasure): KpBox {
  return {
    kind: "box",
    from: cluster.from,
    to: cluster.to,
    width: measure(cluster.text, "prose"),
    text: cluster.text,
  };
}

function boundaryGlue(
  position: number,
  width: number,
  stretch: number,
  shrink: number,
  role: KpGlue["role"],
  stretchOrder: 0 | 1 = 0,
  breakWidth = 0,
): KpGlue {
  return {
    kind: "glue",
    from: position,
    to: position,
    width,
    stretch,
    stretchOrder,
    shrink,
    role,
    breakWidth,
  };
}

function forcedBreak(position: number): KpPenalty {
  return {
    kind: "penalty",
    from: position,
    to: position,
    width: 0,
    penalty: KP_FORCED_BREAK,
  };
}

function canBreakBetween(left: Cluster, right: Cluster): boolean {
  if (NUMERIC_PREFIX.has(left.text) && right.kind === "latin") return false;
  if (left.kind === "latin" && NUMERIC_SUFFIX.has(right.text)) return false;
  if (left.kind === "open" || right.kind === "close") return false;
  if (left.kind === "latin" && right.kind === "latin") return false;
  return left.kind === "han"
    || right.kind === "han"
    || left.kind === "close"
    || left.kind === "other";
}

function isCjkLatinBoundary(left: Cluster, right: Cluster): boolean {
  return (left.kind === "han" && right.kind === "latin")
    || (left.kind === "latin" && right.kind === "han");
}

function hangingWidth(
  cluster: Cluster | undefined,
  em: number,
  measure: MixedCjkMeasure,
): number {
  if (!cluster || !CLOSE_PUNCTUATION.has(cluster.text)) return 0;
  return -Math.min(em * 0.5, measure(cluster.text, "prose") * 0.5);
}

function compressAdjacentPunctuation(items: KpItem[], left: Cluster | undefined, right: Cluster, em: number): void {
  if (!left) return;
  const leftClose = CLOSE_PUNCTUATION.has(left.text);
  const rightClose = CLOSE_PUNCTUATION.has(right.text);
  const leftOpen = OPEN_PUNCTUATION.has(left.text);
  const rightOpen = OPEN_PUNCTUATION.has(right.text);
  const compress = (leftClose && (rightClose || rightOpen)) || (leftOpen && rightOpen);
  if (!compress) return;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item?.kind !== "box") continue;
    const amount = Math.min(em * 0.5, item.width * 0.5);
    item.width -= amount;
    item.tracking = (item.tracking ?? 0) - amount;
    return;
  }
}

/**
 * Tokenise plain Chinese/Latin prose into measured KP items.
 *
 * This is deliberately a disclosed UAX #14/CLReq tailoring, not a claim of
 * complete Unicode line-break conformance. Grapheme segmentation remains the
 * browser's current Unicode implementation.
 */
export function mixedCjkItems(text: string, options: MixedCjkOptions): KpItem[] {
  const sourceFrom = options.from ?? 0;
  const hiddenRanges = [...(options.hiddenRanges ?? [])]
    .filter((range) => range.to > range.from)
    .sort((left, right) => left.from - right.from);
  let hiddenIndex = 0;
  const clusters = clustersFor(text, sourceFrom).filter((cluster) => {
    while (hiddenRanges[hiddenIndex]?.to <= cluster.from) hiddenIndex++;
    const hidden = hiddenRanges[hiddenIndex];
    return !hidden || hidden.from > cluster.from || hidden.to < cluster.to;
  });
  const items: KpItem[] = [];
  const em = Math.max(1, options.em);
  const wordSpace = Math.max(0, options.measure(" ", "prose"));

  for (let index = 0; index < clusters.length; index++) {
    const cluster = clusters[index]!;
    const previous = clusters[index - 1];

    if (cluster.kind === "newline") {
      const hard = options.hardBreakEnds?.has(cluster.to) ?? false;
      if (hard) {
        items.push(forcedBreak(cluster.to));
      } else {
        items.push({
          kind: "glue",
          from: cluster.from,
          to: cluster.to,
          width: wordSpace,
          stretch: wordSpace * 0.5,
          shrink: wordSpace / 3,
          role: "soft-newline",
          breakWidth: hangingWidth(previous, em, options.measure),
        });
      }
      continue;
    }

    if (cluster.kind === "space") {
      // Only the first source space in a run is elastic. Remaining spaces keep
      // their width but do not create extra stretch, matching Telari's policy.
      const elastic = previous?.kind !== "space";
      items.push({
        kind: "glue",
        from: cluster.from,
        to: cluster.to,
        width: options.measure(cluster.text, "prose"),
        stretch: elastic ? wordSpace * 0.5 : 0,
        shrink: elastic ? wordSpace / 3 : 0,
        role: "word",
        breakable: elastic,
        breakWidth: elastic ? hangingWidth(previous, em, options.measure) : 0,
      });
      continue;
    }

    compressAdjacentPunctuation(items, previous, cluster, em);

    if (previous && previous.kind !== "newline" && previous.kind !== "space") {
      if (isCjkLatinBoundary(previous, cluster)) {
        items.push(boundaryGlue(cluster.from, em * 0.25, 0, em * 0.125, "cjk-latin"));
      } else if (canBreakBetween(previous, cluster)) {
        const adjustable = previous.kind === "han" && cluster.kind === "han";
        items.push(boundaryGlue(
          cluster.from,
          0,
          adjustable ? em * 0.25 : 0,
          0,
          "cjk",
          1,
          hangingWidth(previous, em, options.measure),
        ));
      }
    }

    // Keep a Latin word in one box. URLs/hashes therefore stay intact unless
    // the renderer explicitly supplies emergency penalties for an overlong run.
    if (cluster.kind === "latin") {
      let end = index + 1;
      while (end < clusters.length) {
        if (clusters[end]?.kind === "latin") {
          end++;
          continue;
        }
        if (!LATIN_JOINER.has(clusters[end]!.text)) break;
        let next = end;
        while (LATIN_JOINER.has(clusters[next]?.text ?? "")) next++;
        if (clusters[next]?.kind !== "latin") break;
        end = next + 1;
      }
      const run = clusters.slice(index, end);
      const runText = run.map((part) => part.text).join("");
      const runWidth = options.measure(runText, "prose");
      if (options.emergencyLineWidth && runWidth > options.emergencyLineWidth) {
        for (let runIndex = 0; runIndex < run.length; runIndex++) {
          items.push(box(run[runIndex]!, options.measure));
          if (runIndex < run.length - 1) {
            const position = run[runIndex]!.to;
            items.push({
              kind: "penalty",
              from: position,
              to: position,
              width: 0,
              penalty: 1_000,
              flagged: true,
            });
          }
        }
      } else {
        items.push({
          kind: "box",
          from: cluster.from,
          to: run.at(-1)!.to,
          width: runWidth,
          text: runText,
        });
      }
      index = end - 1;
      continue;
    }

    items.push(box(cluster, options.measure));
  }

  const end = sourceFrom + text.length;
  if (items.at(-1)?.kind !== "penalty" || (items.at(-1) as KpPenalty).penalty > KP_FORCED_BREAK) {
    items.push(forcedBreak(end));
  }
  return items;
}
