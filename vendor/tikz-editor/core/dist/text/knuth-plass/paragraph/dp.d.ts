import type { ParagraphModel } from './items.js';
import type { GreedyLine } from './types.js';
export interface DpResult {
    lines: GreedyLine[];
    errors: string[];
    canProceed: boolean;
    totalCost: number;
    mode: 'feasible' | 'overfull';
}
export interface DpOptions {
    tolerance?: number;
    linepenalty?: number;
    adjdemerits?: number;
    doublehyphendemerits?: number;
    finalhyphendemerits?: number;
    leftskipWidth?: number;
    leftskipStretch?: number;
    leftskipShrink?: number;
    rightskipWidth?: number;
    rightskipStretch?: number;
    rightskipShrink?: number;
    parfillskipWidth?: number;
    parfillskipStretch?: number;
    parfillskipShrink?: number;
    preventOverflow?: boolean;
    allowInfeasible?: boolean;
}
export declare function breakWithDp(model: ParagraphModel, width: number, options?: DpOptions): DpResult;
