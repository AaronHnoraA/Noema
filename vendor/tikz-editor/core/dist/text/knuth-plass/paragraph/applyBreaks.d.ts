import type { BreakDecision, GreedyLine, AnyWrapper, ParagraphRun } from './types.js';
import type { ParagraphAlignment } from '../alignment.js';
import type { WrappedTextGap } from '../install.js';
export interface AppliedBreak extends BreakDecision {
    lineIndex: number;
}
export interface ApplyBreaksOptions {
    originalMtextTextByWrapper?: WeakMap<object, string[]>;
    originalMspaceWidthByWrapper?: WeakMap<object, string | undefined>;
    alignment?: ParagraphAlignment;
    targetWidth?: number;
    paragraphId?: string;
    wrappedTextGaps?: WrappedTextGap[];
}
export interface ApplyBreaksResult {
    appliedBreaks: AppliedBreak[];
    canProceed: boolean;
    errors: string[];
}
export declare function applyBreaks(paragraphWrapper: AnyWrapper, runs: ParagraphRun[], lines: GreedyLine[], options?: ApplyBreaksOptions): ApplyBreaksResult;
