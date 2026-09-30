import type { Span } from "../../ast/types.js";
import type { OptionListAst } from "../../options/types.js";
import { type SemanticContext } from "../context.js";
import type { SceneElement } from "../types.js";
export type NameIntersectionsDirective = {
    firstPathName: string;
    secondPathName: string;
    prefix: string;
    byNames: string[];
    sortBy?: string;
    totalMacro?: string;
    span: Span;
};
export type PathIntersectionDirectives = {
    namedPathNames: string[];
    nameIntersections?: NameIntersectionsDirective;
    diagnostics: string[];
};
export declare function collectPathIntersectionDirectives(optionLists: OptionListAst[]): PathIntersectionDirectives;
export declare function applyNameIntersectionsDirective(directive: NameIntersectionsDirective, context: SemanticContext): string[];
export declare function registerNamedPath(pathName: string, elements: SceneElement[], context: SemanticContext): boolean;
