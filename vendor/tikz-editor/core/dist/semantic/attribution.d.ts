import type { PathItem, Span, Statement } from "../ast/types.js";
import type { Diagnostic } from "../diagnostics/types.js";
import type { ExpansionSourceMap, ForeachOriginFrame as ExpansionForeachOriginFrame, ForeachStatementAttribution } from "../foreach/types.js";
import type { MacroOriginFrame } from "../macros/index.js";
import type { EditHandle, SceneElement } from "./types.js";
export declare function mapExpansionSpan(sourceMap: ExpansionSourceMap, span: Span): Span;
export declare function remapDiagnostics(diagnostics: Diagnostic[], fromIndex: number, sourceMap: ExpansionSourceMap | undefined, args?: {
    statement?: Statement;
    elements?: readonly SceneElement[];
    pathItemSourceMaps?: WeakMap<PathItem, ExpansionSourceMap>;
}): void;
export declare function finalizeExpandedStatementElements(args: {
    statement: Statement;
    elements: SceneElement[];
    statementAttribution: WeakMap<Statement, ForeachStatementAttribution>;
    statementSourceMap: ExpansionSourceMap | undefined;
    pathItemForeachStack: WeakMap<PathItem, ExpansionForeachOriginFrame[]>;
    pathItemSourceMaps: WeakMap<PathItem, ExpansionSourceMap>;
    statementMacroAttribution: WeakMap<Statement, MacroOriginFrame[]>;
    templateLocalIdByExpandedId: ReadonlyMap<string, string>;
}): SceneElement[];
export declare function finalizeExpandedStatementHandles(args: {
    statement: Statement;
    handles: EditHandle[];
    startIndex: number;
    statementAttribution: WeakMap<Statement, ForeachStatementAttribution>;
    statementSourceMap: ExpansionSourceMap | undefined;
    pathItemSourceMaps: WeakMap<PathItem, ExpansionSourceMap>;
    source: string;
}): void;
