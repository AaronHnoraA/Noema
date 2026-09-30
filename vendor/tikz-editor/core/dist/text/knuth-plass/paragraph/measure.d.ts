import type { AnyWrapper, ParagraphRun } from './types.js';
export interface MeasurementStats {
    textCacheEntries: number;
    wordPrefixEntries: number;
    mathCacheEntries: number;
}
export interface MeasurementService {
    measureText(text: string, mtextWrapper: AnyWrapper | null | undefined): number;
    measureWord(word: string, mtextWrapper: AnyWrapper | null | undefined): number;
    measurePrefix(word: string, n: number, mtextWrapper: AnyWrapper | null | undefined): number;
    measureMath(wrapper: AnyWrapper | null | undefined): number;
    precomputeWord(word: string, mtextWrapper: AnyWrapper | null | undefined): void;
    primeRuns(runs: ParagraphRun[]): void;
    getStats(): MeasurementStats;
}
export declare function createMeasurementService(): MeasurementService;
