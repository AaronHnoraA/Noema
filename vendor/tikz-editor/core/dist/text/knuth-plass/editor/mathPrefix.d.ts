import type { MathDelimiterKind, MathSourceSpan } from './sourceParser.js';
interface PrefixState {
    inMath: boolean;
    mathMode: 'none' | 'dollar' | 'paren';
    braceDepth: number;
    trailingEscape: boolean;
    unclosedLeftCount: number;
}
export interface MathPrefixCache {
    getOrBuild(outputJax: unknown, span: MathSourceSpan): Promise<number[]>;
}
export declare function hasDanglingMathScriptOperator(text: string): boolean;
export declare function scanTeXPrefixState(text: string): PrefixState;
export declare function stabilizePrefixForMeasurement(prefix: string): string;
export declare function seedPrefixWidthTable(length: number, totalWidth: number): number[];
export declare function finalizePrefixWidthTable(table: number[], totalWidth: number): number[];
export declare function readPrefixUnitsFromTable(index: number, sourceLength: number, totalWidth: number, table: number[]): number;
export declare function findNearestPrefixIndexFromTable(targetUnits: number, sourceLength: number, totalWidth: number, table: number[]): number;
export declare function normalizeMathSourceForCache(delimiter: MathDelimiterKind, content: string): string;
export declare function createMathPrefixCache(limit?: number): MathPrefixCache;
export {};
