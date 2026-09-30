import type { Hyphenator } from './hyphenate.js';
import type { MeasurementService } from './measure.js';
import type { BreakRef, ParagraphRun } from './types.js';
export interface BoxItem {
    kind: 'box';
    width: number;
    payload: {
        runIndex: number;
        runKind: 'text' | 'math';
        text?: string;
    };
}
export interface GlueItem {
    kind: 'glue';
    width: number;
    stretch: number;
    shrink: number;
    payload: {
        runIndex: number;
        breakRef: BreakRef;
    };
}
export interface PenaltyItem {
    kind: 'penalty';
    width: number;
    penalty: number;
    flagged?: boolean;
    payload: {
        runIndex: number;
        breakRef?: BreakRef;
        breakKind: 'space' | 'hyphen' | 'forced';
        sourceOffset: number;
        visibleHyphen: boolean;
        splitOffset?: number;
        hyphenSource?: 'automatic' | 'explicit';
    };
}
export type Item = BoxItem | GlueItem | PenaltyItem;
export interface ParagraphBuildOptions {
    hyphenator?: Hyphenator | null;
    enableAutomaticHyphenation?: boolean;
    hyphenpenalty?: number;
    exhyphenpenalty?: number;
    spaceStretch?: number;
    spaceShrink?: number;
}
export interface ParagraphModel {
    runs: ParagraphRun[];
    items: Item[];
    runWidths: Map<number, number>;
    errors: string[];
    measurement: MeasurementService;
}
export declare function runsToItems(runs: ParagraphRun[], measurement: MeasurementService, options?: ParagraphBuildOptions): ParagraphModel;
export declare function getBreakableRunIndices(items: Item[]): Set<number>;
