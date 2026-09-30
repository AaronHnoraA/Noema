import type { OptionEntry, OptionListAst } from "../../options/types.js";
export declare function splitTopLevel(raw: string, separators: string[], from: number): Array<{
    raw: string;
    from: number;
}>;
export declare function readConnector<T extends string>(raw: string, start: number, operators: readonly T[]): {
    operator: T;
    index: number;
    next: number;
} | null;
export declare function findNextConnector<T extends string>(raw: string, start: number, operators: readonly T[]): {
    operator: T;
    index: number;
} | null;
export declare function readBalancedSegment(raw: string, start: number, open: string, close: string): {
    raw: string;
    next: number;
} | null;
export declare function findTopLevelChar(raw: string, needle: string): number;
export declare function mergeOptionLists(optionLists: OptionListAst[]): OptionListAst | undefined;
export declare function optionListIfPresent(optionList: OptionListAst | undefined): OptionListAst[];
export declare function optionListFromEntries(entries: OptionEntry[], base: OptionListAst): OptionListAst | undefined;
export declare function stripOptionListBrackets(raw: string): string;
export declare function trimRightIndex(raw: string): number;
export declare function skipWhitespace(raw: string, cursor: number): number;
