import type { PathItem, Span, Statement } from "../ast/types.js";
import { type ParseTikzResult } from "../parser/index.js";
export type ForeachSnippetParseResult<T> = {
    value: T;
    hasParseError: boolean;
};
export type ForeachSnippetSourceMapper = {
    mapSpan: (span: Span) => Span | null;
    mapOffset: (offset: number) => number | null;
};
export type ForeachStatementBodyParseResult = {
    parseResult: ParseTikzResult;
    hasParseError: boolean;
    sourceMapper: ForeachSnippetSourceMapper;
};
export type PathFragmentParseResult = {
    value: PathItem[];
    hasParseError: boolean;
    sourceMapper: ForeachSnippetSourceMapper;
};
export declare function parseStatementsFromBody(bodyRaw: string): ForeachSnippetParseResult<Statement[]>;
export declare function parseStatementsFromBodyWithMapping(bodyRaw: string, bodySpan: Span): ForeachStatementBodyParseResult;
export declare function parsePathItemsFromFragment(pathFragmentRaw: string): ForeachSnippetParseResult<PathItem[]>;
export declare function parsePathItemsFromFragmentWithMapping(pathFragmentRaw: string, fragmentSpan: Span): PathFragmentParseResult;
export declare function parsePathItemsFromFragmentWithSyntheticMapping(pathFragmentRaw: string, fragmentSpan: Span): PathFragmentParseResult;
export declare function parseNodeItemsFromTemplate(nodeTemplateRaw: string): ForeachSnippetParseResult<PathItem[]>;
