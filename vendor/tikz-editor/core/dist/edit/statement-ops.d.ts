import type { Statement, Span } from "../ast/types.js";
import type { SourcePatch } from "./types.js";
import { type EditParseOptions } from "./parse-options.js";
export type StatementRef = {
    id: string;
    span: Span;
    statement: Statement;
    parentKey: string;
    depth: number;
    index: number;
};
export type StatementSnapshot = {
    source: string;
    all: StatementRef[];
    byId: Map<string, StatementRef>;
    byParentKey: Map<string, StatementRef[]>;
};
export type StatementParentGroup = {
    parentKey: string;
    depth: number;
    refs: StatementRef[];
};
export type TextReplacement = {
    span: Span;
    text: string;
};
export type AppliedTextReplacement = {
    oldSpan: Span;
    newSpan: Span;
};
export declare function buildStatementSnapshotFromStatements(source: string, statements: readonly Statement[]): StatementSnapshot;
export declare function parseStatementSnapshot(source: string, parseOptions?: EditParseOptions): StatementSnapshot;
export declare function resolveStatementRefs(snapshot: StatementSnapshot, elementIds: readonly string[]): StatementRef[];
export declare function groupStatementRefsByParent(refs: readonly StatementRef[]): StatementParentGroup[];
export declare function lineIndentAtOffset(source: string, offset: number): string;
export declare function resolveRootInsertionPoint(source: string): {
    offset: number;
    indent: string;
};
export declare function formatSnippetsForInsertion(snippets: readonly string[], indent: string, options?: {
    trailingNewline?: boolean;
    newline?: string;
}): {
    text: string;
    snippetSpans: Span[];
};
export declare function applyTextReplacements(source: string, replacements: readonly TextReplacement[]): {
    source: string;
    patches: SourcePatch[];
    applied: AppliedTextReplacement[];
};
export declare function shiftSpansAfterReplacement(spans: readonly Span[], oldSpan: Span, newSpan: Span): Span[];
export declare function mapSpansToStatementIds(source: string, spans: readonly Span[]): string[];
export declare function statementSnippet(source: string, ref: StatementRef): string;
