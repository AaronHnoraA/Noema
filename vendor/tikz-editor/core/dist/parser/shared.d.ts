import type { Statement } from "../ast/types.js";
export type ContextDefinitionCacheEntry = {
    prefix: string;
    definitions: Statement[];
};
export declare function getCachedContextDefinitions(prefix: string, collectContextDefinitions: (prefix: string) => Statement[]): Statement[];
export declare function resolveParseWindowSource(source: string, activeFigureSpan: {
    from: number;
    to: number;
} | null): string;
export declare function resolveActiveFigureSpan(spans: readonly {
    from: number;
    to: number;
}[], activeFigureId: string | null | undefined): {
    from: number;
    to: number;
} | null;
export declare function scanFigureSpans(source: string): Array<{
    from: number;
    to: number;
}>;
export declare function parseFigureIndexFromId(figureId: string): number | null;
