/**
 * A DOM-independent Knuth-Plass paragraph optimiser.
 *
 * The renderer owns shaping and turns Markdown into boxes/glues/penalties.
 * This module only consumes measured widths. Candidate line metrics are prefix
 * sums, so evaluating one edge in the breakpoint DAG is O(1). Keeping the
 * implementation pure makes it usable in a Worker and lets incremental editor
 * state reuse an unchanged DP prefix without retaining DOM objects.
 */

export const KP_FORCED_BREAK = -1_000_000;
export const KP_FORBIDDEN_BREAK = 1_000_000;

export type KpGlueRole = "word" | "cjk" | "cjk-latin" | "soft-newline";

export type KpBox = {
  kind: "box";
  from: number;
  to: number;
  width: number;
  text?: string;
  /** Visual tracking applied by the renderer and already included in width. */
  tracking?: number;
};

export type KpGlue = {
  kind: "glue";
  from: number;
  to: number;
  width: number;
  stretch: number;
  /** Secondary stretch is consumed only after ordinary word-space stretch. */
  stretchOrder?: 0 | 1;
  shrink: number;
  role: KpGlueRole;
  /** Signed width adjustment used only when the line breaks at this glue. */
  breakWidth?: number;
  /** A glue normally creates a legal breakpoint. */
  breakable?: boolean;
};

export type KpPenalty = {
  kind: "penalty";
  from: number;
  to: number;
  /** Width added only when the line breaks at this penalty, e.g. a hyphen. */
  width: number;
  penalty: number;
  flagged?: boolean;
};

export type KpItem = KpBox | KpGlue | KpPenalty;

export type KpOptions = {
  lineWidth: number;
  justify?: boolean;
  tolerance?: number;
  fitnessDemerit?: number;
  flaggedDemerit?: number;
  runtPenalty?: number;
};

export type KpGlueAdjustment = {
  item: number;
  delta: number;
};

export type KpLine = {
  fromItem: number;
  toItem: number;
  breakItem: number;
  from: number;
  to: number;
  ratio: number;
  fitness: number;
  naturalWidth: number;
  targetWidth: number;
  justified: boolean;
  adjustments: readonly KpGlueAdjustment[];
};

export type KpLayout = {
  lines: readonly KpLine[];
  demerits: number;
  feasible: boolean;
  evaluatedEdges: number;
  breakpoints: number;
  /** Breakpoints whose complete four-fitness DP frontier was reused. */
  reusedBreakpoints: number;
  /** Opaque paragraph-local state accepted by the next incremental run. */
  incremental?: KpIncrementalCache;
};

type Breakpoint = {
  item: number;
  nextItem: number;
  position: number;
  penalty: number;
  penaltyWidth: number;
  flagged: boolean;
  mandatory: boolean;
};

type PrefixMetrics = {
  width: Float64Array;
  stretch0: Float64Array;
  stretch1: Float64Array;
  shrink: Float64Array;
  boxes: Uint32Array;
};

type CandidateMetrics = {
  naturalWidth: number;
  stretch0: number;
  stretch1: number;
  shrink: number;
  boxCount: number;
  ratio: number;
  fitness: number;
  feasible: boolean;
  justified: boolean;
};

type State = {
  breakpoint: number;
  fitness: number;
  flagged: boolean;
  total: number;
  previous: State | null;
  metrics: CandidateMetrics | null;
};

type ResolvedOptions = Required<Pick<
  KpOptions,
  "lineWidth" | "justify" | "tolerance" | "fitnessDemerit" | "flaggedDemerit" | "runtPenalty"
>>;

/**
 * Paragraph-local continuation data. It deliberately contains no DOM values,
 * so editor caches can drop it cheaply and a future Worker transport can
 * replace it with a serialised checkpoint representation.
 */
export type KpIncrementalCache = {
  readonly items: readonly KpItem[];
  readonly points: readonly Breakpoint[];
  readonly states: readonly (readonly (State | undefined)[])[];
  readonly options: ResolvedOptions;
};

const DEFAULT_TOLERANCE = 2;
const DEFAULT_FITNESS_DEMERIT = 100;
const DEFAULT_FLAGGED_DEMERIT = 135;
const DEFAULT_RUNT_PENALTY = 100;
const BOUND_EPSILON = 1e-6;

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function effectiveGlueShrink(item: KpGlue): number {
  // A glue cannot physically shrink past zero width. Besides making malformed
  // caller input harmless, this invariant makes overfull-edge pruning
  // monotonic as candidate starts move left.
  return Math.min(finiteNonNegative(item.shrink), finiteNonNegative(item.width));
}

function buildPrefixMetrics(items: readonly KpItem[]): PrefixMetrics {
  const width = new Float64Array(items.length + 1);
  const stretch0 = new Float64Array(items.length + 1);
  const stretch1 = new Float64Array(items.length + 1);
  const shrink = new Float64Array(items.length + 1);
  const boxes = new Uint32Array(items.length + 1);

  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    width[index + 1] = width[index];
    stretch0[index + 1] = stretch0[index];
    stretch1[index + 1] = stretch1[index];
    shrink[index + 1] = shrink[index];
    boxes[index + 1] = boxes[index];

    if (item.kind === "box") {
      width[index + 1] += finiteNonNegative(item.width);
      boxes[index + 1] += 1;
    } else if (item.kind === "glue") {
      width[index + 1] += finiteNonNegative(item.width);
      if (item.stretchOrder === 1) {
        stretch1[index + 1] += finiteNonNegative(item.stretch);
      } else {
        stretch0[index + 1] += finiteNonNegative(item.stretch);
      }
      shrink[index + 1] += effectiveGlueShrink(item);
    }
  }

  return { width, stretch0, stretch1, shrink, boxes };
}

function breakpointsFor(items: readonly KpItem[]): Breakpoint[] {
  const points: Breakpoint[] = [{
    item: -1,
    nextItem: 0,
    position: items[0]?.from ?? 0,
    penalty: KP_FORCED_BREAK,
    penaltyWidth: 0,
    flagged: false,
    mandatory: true,
  }];

  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    if (item.kind === "glue" && item.breakable !== false) {
      let nextItem = index + 1;
      while (nextItem < items.length && items[nextItem]?.kind === "glue") nextItem++;
      points.push({
        item: index,
        nextItem,
        position: item.to,
        penalty: 0,
        penaltyWidth: Number.isFinite(item.breakWidth) ? item.breakWidth ?? 0 : 0,
        flagged: false,
        mandatory: false,
      });
    } else if (item.kind === "penalty" && item.penalty < KP_FORBIDDEN_BREAK) {
      points.push({
        item: index,
        nextItem: index + 1,
        position: item.to,
        penalty: item.penalty,
        penaltyWidth: finiteNonNegative(item.width),
        flagged: !!item.flagged,
        mandatory: item.penalty <= KP_FORCED_BREAK,
      });
    }
  }

  return points;
}

function difference(values: Float64Array | Uint32Array, from: number, to: number): number {
  return values[to]! - values[from]!;
}

function fitnessFor(ratio: number): number {
  if (ratio < -0.5) return 0;
  if (ratio <= 0.5) return 1;
  if (ratio <= 1) return 2;
  return 3;
}

function metricsFor(
  prefix: PrefixMetrics,
  start: Breakpoint,
  end: Breakpoint,
  lineWidth: number,
  justify: boolean,
  tolerance: number,
): CandidateMetrics {
  const from = start.nextItem;
  const to = end.item;
  const naturalWidth = difference(prefix.width, from, to) + end.penaltyWidth;
  const stretch0 = difference(prefix.stretch0, from, to);
  const stretch1 = difference(prefix.stretch1, from, to);
  const shrink = difference(prefix.shrink, from, to);
  const boxCount = difference(prefix.boxes, from, to);
  const delta = lineWidth - naturalWidth;
  const justified = justify && !end.mandatory;

  let ratio = 0;
  let feasible = true;
  if (delta < 0) {
    ratio = shrink > 0 ? delta / shrink : Number.NEGATIVE_INFINITY;
    feasible = ratio >= -1;
  } else if (justified) {
    if (stretch0 > 0 && (delta <= stretch0 || stretch1 <= 0)) {
      ratio = delta / stretch0;
    } else if (stretch1 > 0) {
      ratio = 1 + Math.max(0, delta - stretch0) / stretch1;
    } else if (delta > 0) {
      ratio = Number.POSITIVE_INFINITY;
    }
    feasible = ratio <= tolerance;
  }

  return {
    naturalWidth,
    stretch0,
    stretch1,
    shrink,
    boxCount,
    ratio,
    fitness: fitnessFor(ratio),
    feasible,
    justified,
  };
}

function lineDemerits(
  metrics: CandidateMetrics,
  end: Breakpoint,
  previous: State,
  options: Required<Pick<KpOptions, "fitnessDemerit" | "flaggedDemerit" | "runtPenalty">>,
): number {
  if (!metrics.feasible) return Number.POSITIVE_INFINITY;
  const finiteRatio = Number.isFinite(metrics.ratio) ? metrics.ratio : 10;
  const badness = metrics.justified || finiteRatio < 0
    ? 100 * Math.abs(finiteRatio) ** 3
    : 0;
  let demerits = (1 + badness) ** 2;
  if (end.penalty >= 0) {
    demerits += end.penalty ** 2;
  } else if (!end.mandatory) {
    demerits -= end.penalty ** 2;
  }
  if (Math.abs(metrics.fitness - previous.fitness) > 1) {
    demerits += options.fitnessDemerit;
  }
  if (previous.flagged && end.flagged) demerits += options.flaggedDemerit;
  if (end.mandatory && metrics.boxCount <= 1 && previous.previous) {
    demerits += options.runtPenalty;
  }
  return demerits;
}

function adjustmentsFor(
  items: readonly KpItem[],
  fromItem: number,
  breakItem: number,
  metrics: CandidateMetrics,
  lineWidth: number,
): KpGlueAdjustment[] {
  if (!metrics.justified && metrics.naturalWidth <= lineWidth) return [];
  let delta = lineWidth - metrics.naturalWidth;
  if (Math.abs(delta) < 0.001) return [];

  const primary: number[] = [];
  const secondary: number[] = [];
  let primaryCapacity = 0;
  let secondaryCapacity = 0;
  let shrinkCapacity = 0;
  for (let index = fromItem; index < breakItem; index++) {
    const item = items[index];
    if (item?.kind !== "glue") continue;
    if (delta < 0) {
      const shrink = effectiveGlueShrink(item);
      if (shrink > 0) {
        primary.push(index);
        shrinkCapacity += shrink;
      }
    } else if (item.stretchOrder === 1) {
      if (item.stretch > 0) {
        secondary.push(index);
        secondaryCapacity += item.stretch;
      }
    } else if (item.stretch > 0) {
      primary.push(index);
      primaryCapacity += item.stretch;
    }
  }

  const result: KpGlueAdjustment[] = [];
  if (delta < 0) {
    if (shrinkCapacity <= 0) return result;
    for (const index of primary) {
      const item = items[index] as KpGlue;
      result.push({ item: index, delta: delta * effectiveGlueShrink(item) / shrinkCapacity });
    }
    return result;
  }

  const primaryDelta = Math.min(delta, primaryCapacity);
  if (primaryCapacity > 0) {
    for (const index of primary) {
      const item = items[index] as KpGlue;
      result.push({ item: index, delta: primaryDelta * item.stretch / primaryCapacity });
    }
  }
  delta -= primaryDelta;
  if (delta > 0 && secondaryCapacity > 0) {
    for (const index of secondary) {
      const item = items[index] as KpGlue;
      result.push({ item: index, delta: delta * item.stretch / secondaryCapacity });
    }
  }
  return result;
}

function sameOptions(left: ResolvedOptions, right: ResolvedOptions): boolean {
  return left.lineWidth === right.lineWidth
    && left.justify === right.justify
    && left.tolerance === right.tolerance
    && left.fitnessDemerit === right.fitnessDemerit
    && left.flaggedDemerit === right.flaggedDemerit
    && left.runtPenalty === right.runtPenalty;
}

function sameItem(left: KpItem, right: KpItem, offsetDelta: number): boolean {
  if (left.kind !== right.kind
      || left.from + offsetDelta !== right.from
      || left.to + offsetDelta !== right.to) return false;
  if (left.kind === "box" && right.kind === "box") {
    return left.width === right.width
      && left.text === right.text
      && left.tracking === right.tracking;
  }
  if (left.kind === "glue" && right.kind === "glue") {
    return left.width === right.width
      && left.stretch === right.stretch
      && left.stretchOrder === right.stretchOrder
      && left.shrink === right.shrink
      && left.role === right.role
      && left.breakWidth === right.breakWidth
      && left.breakable === right.breakable;
  }
  if (left.kind === "penalty" && right.kind === "penalty") {
    return left.width === right.width
      && left.penalty === right.penalty
      && left.flagged === right.flagged;
  }
  return false;
}

function reusableBreakpointCount(
  items: readonly KpItem[],
  points: readonly Breakpoint[],
  previous: KpIncrementalCache | undefined,
  options: ResolvedOptions,
): number {
  if (!previous || !sameOptions(previous.options, options)) return 0;
  const offsetDelta = items.length > 0 && previous.items.length > 0
    ? items[0]!.from - previous.items[0]!.from
    : 0;
  let commonItems = 0;
  const limit = Math.min(items.length, previous.items.length);
  while (commonItems < limit
      && sameItem(previous.items[commonItems]!, items[commonItems]!, offsetDelta)) {
    commonItems++;
  }

  // Point zero is the empty paragraph prefix. Every later reused point must
  // end fully inside the identical item prefix; this also covers skipped glue
  // runs through `nextItem`.
  let reusable = 1;
  const pointLimit = Math.min(points.length, previous.points.length);
  for (let index = 1; index < pointLimit; index++) {
    const current = points[index]!;
    const old = previous.points[index]!;
    if (current.item >= commonItems
        || current.nextItem > commonItems
        || current.item !== old.item
        || current.nextItem !== old.nextItem
        || current.penalty !== old.penalty
        || current.penaltyWidth !== old.penaltyWidth
        || current.flagged !== old.flagged
        || current.mandatory !== old.mandatory) break;
    reusable = index + 1;
  }
  return Math.min(reusable, previous.states.length);
}

/** Find the globally minimum-demerit layout for one measured paragraph. */
export function breakParagraph(
  items: readonly KpItem[],
  input: KpOptions,
  previous?: KpIncrementalCache,
): KpLayout {
  const lineWidth = finiteNonNegative(input.lineWidth);
  if (!lineWidth || items.length === 0) {
    return {
      lines: [],
      demerits: 0,
      feasible: items.length === 0,
      evaluatedEdges: 0,
      breakpoints: 0,
      reusedBreakpoints: 0,
    };
  }

  const options: ResolvedOptions = {
    lineWidth,
    justify: input.justify ?? true,
    tolerance: input.tolerance ?? DEFAULT_TOLERANCE,
    fitnessDemerit: input.fitnessDemerit ?? DEFAULT_FITNESS_DEMERIT,
    flaggedDemerit: input.flaggedDemerit ?? DEFAULT_FLAGGED_DEMERIT,
    runtPenalty: input.runtPenalty ?? DEFAULT_RUNT_PENALTY,
  };
  const points = breakpointsFor(items);
  if (points.length < 2 || !points.at(-1)?.mandatory) {
    return {
      lines: [],
      demerits: Number.POSITIVE_INFINITY,
      feasible: false,
      evaluatedEdges: 0,
      breakpoints: points.length,
      reusedBreakpoints: 0,
    };
  }

  const prefix = buildPrefixMetrics(items);
  const states: Array<Array<State | undefined>> = Array.from({ length: points.length }, () => []);
  const reusedCount = reusableBreakpointCount(items, points, previous, options);
  for (let index = 0; index < reusedCount; index++) {
    states[index] = [...previous!.states[index]!];
  }
  if (reusedCount === 0) {
    states[0]![1] = {
      breakpoint: 0,
      fitness: 1,
      flagged: false,
      total: 0,
      previous: null,
      metrics: null,
    };
  }
  let evaluatedEdges = 0;
  let mandatoryFloor = 0;
  for (let index = 1; index < reusedCount; index++) {
    if (points[index]!.mandatory) mandatoryFloor = index;
  }

  for (let endIndex = Math.max(1, reusedCount); endIndex < points.length; endIndex++) {
    const end = points[endIndex]!;
    for (let startIndex = endIndex - 1; startIndex >= mandatoryFloor; startIndex--) {
      const startStates = states[startIndex]!;
      if (!startStates.some(Boolean)) continue;
      const metrics = metricsFor(
        prefix,
        points[startIndex]!,
        end,
        options.lineWidth,
        options.justify,
        options.tolerance,
      );
      evaluatedEdges++;
      // Widths are non-negative. Once even full shrink cannot fit, every
      // earlier candidate start is wider and can be skipped.
      if (metrics.ratio < -1) break;
      if (!metrics.feasible) continue;

      for (const previous of startStates) {
        if (!previous) continue;
        const total = previous.total + lineDemerits(metrics, end, previous, options);
        const current = states[endIndex]![metrics.fitness];
        if (!current || total < current.total - BOUND_EPSILON) {
          states[endIndex]![metrics.fitness] = {
            breakpoint: endIndex,
            fitness: metrics.fitness,
            flagged: end.flagged,
            total,
            previous,
            metrics,
          };
        }
      }
    }
    // No later line may cross a forced Markdown break.
    if (end.mandatory) mandatoryFloor = endIndex;
  }

  const finalState = states.at(-1)!
    .filter((state): state is State => !!state)
    .sort((left, right) => left.total - right.total)[0];
  if (!finalState) {
    return {
      lines: [],
      demerits: Number.POSITIVE_INFINITY,
      feasible: false,
      evaluatedEdges,
      breakpoints: points.length - 1,
      reusedBreakpoints: Math.max(0, reusedCount - 1),
      incremental: { items, points, states, options },
    };
  }

  const chain: State[] = [];
  for (let state: State | null = finalState; state?.previous; state = state.previous) chain.push(state);
  chain.reverse();
  const lines = chain.map((state): KpLine => {
    const previous = state.previous!;
    const start = points[previous.breakpoint]!;
    const end = points[state.breakpoint]!;
    const metrics = state.metrics!;
    return {
      fromItem: start.nextItem,
      toItem: end.item,
      breakItem: end.item,
      from: start.position,
      to: end.position,
      ratio: metrics.ratio,
      fitness: metrics.fitness,
      naturalWidth: metrics.naturalWidth,
      targetWidth: options.lineWidth,
      justified: metrics.justified,
      adjustments: adjustmentsFor(items, start.nextItem, end.item, metrics, options.lineWidth),
    };
  });

  return {
    lines,
    demerits: finalState.total,
    feasible: true,
    evaluatedEdges,
    breakpoints: points.length - 1,
    reusedBreakpoints: Math.max(0, reusedCount - 1),
    incremental: { items, points, states, options },
  };
}
