import type { MeasurementService } from './measure.js';
import type { AppliedBreak } from './applyBreaks.js';
import type { GreedyLine, ParagraphRun } from './types.js';
import type { ParagraphAlignment } from '../alignment.js';
import type { KnuthPlassLayoutMode } from '../install.js';
export interface ParagraphLayoutReport {
    paragraphId: string;
    width: number;
    alignment: ParagraphAlignment;
    layoutMode: KnuthPlassLayoutMode;
    lines: LineReport[];
    runs: RunReport[];
    errors: string[];
    internalMode: 'canonical' | 'degraded';
    internalDegradeReason: string | null;
    externalFallbackUsed: boolean;
    linebreakingMode: 'feasible' | 'overfull' | 'unknown';
}
export interface LineSegmentReport {
    runIndex: number;
    kind: 'text' | 'space' | 'math';
    text?: string;
    startOffset?: number;
    endOffset?: number;
    sourceStartRaw?: number;
    sourceEndRaw?: number;
    sourceKind?: 'text' | 'math';
    x: number;
    width: number;
    caretStops?: number[];
}
export interface LineReport {
    lineIndex: number;
    startRun: number;
    endRun: number;
    width: number;
    targetWidth: number;
    naturalWidth: number;
    glueSetRatio: number;
    badness: number;
    spaceCount: number;
    spaceDeltaPerGap: number;
    ascent: number;
    descent: number;
    xStart: number;
    xEnd: number;
    break: BreakReport | null;
    segments: LineSegmentReport[];
}
export interface BreakReport {
    kind: 'space' | 'hyphen' | 'forced';
    runIndex: number;
    sourceOffset: number;
    visibleHyphen: boolean;
    lineLeading?: string;
    hyphenSource?: 'automatic' | 'explicit';
    splitOffset?: number;
}
export interface RunReport {
    runIndex: number;
    kind: 'text' | 'space' | 'math';
    sourceStart?: number;
    sourceEnd?: number;
    width: number;
    text?: string;
}
export interface BuildReportInput {
    paragraphId: string;
    width: number;
    alignment: ParagraphAlignment;
    layoutMode: KnuthPlassLayoutMode;
    runs: ParagraphRun[];
    runWidths: Map<number, number>;
    lines: GreedyLine[];
    appliedBreaks: AppliedBreak[];
    measurement?: MeasurementService;
    errors?: string[];
    internalMode?: 'canonical' | 'degraded';
    internalDegradeReason?: string | null;
    externalFallbackUsed?: boolean;
    linebreakingMode?: 'feasible' | 'overfull' | 'unknown';
    lineMetrics?: Array<{
        ascent: number;
        descent: number;
    }>;
}
export declare function getOrBuildTextSegmentCaretStops(segment: LineSegmentReport): number[] | null;
export declare function buildParagraphLayoutReport({ paragraphId, width, alignment, layoutMode, runs, runWidths, lines, appliedBreaks, measurement, errors, internalMode, internalDegradeReason, externalFallbackUsed, linebreakingMode, lineMetrics, }: BuildReportInput): ParagraphLayoutReport;
