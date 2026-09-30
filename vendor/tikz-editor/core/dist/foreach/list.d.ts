export type ForeachListExpansionOptions = {
    parseExpressions: boolean;
};
export declare function expandForeachList(listRaw: string, opts: ForeachListExpansionOptions): string[];
