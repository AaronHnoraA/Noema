export type TeXPrefixMathMode = "none" | "dollar" | "dollar-double" | "paren" | "bracket";
export type TeXPrefixState = {
    inMath: boolean;
    mathMode: TeXPrefixMathMode;
    braceDepth: number;
    trailingEscape: boolean;
    unclosedLeftCount: number;
};
export declare function stabilizePrefixForMeasurement(prefix: string): string;
export declare function scanTeXPrefixState(text: string): TeXPrefixState;
export declare function extendTeXControlWordPrefixEnd(content: string, prefixLength: number): number;
export declare function hasDanglingMathScriptOperator(text: string): boolean;
export declare function seedPrefixWidthTable(sourceLength: number, totalWidthUnits: number): number[];
export declare function finalizePrefixWidthTable(table: readonly number[], totalWidthUnits: number): number[];
export declare function readPrefixUnitsFromTable(index: number, sourceLength: number, totalWidthUnits: number, table: readonly number[] | null | undefined): number;
export declare function findNearestPrefixIndexFromTable(targetUnits: number, sourceLength: number, totalWidthUnits: number, table: readonly number[] | null | undefined): number;
