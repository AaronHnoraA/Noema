import type { PropertyTargetResolution } from "../property-target.js";
import type { StyleChainEntry } from "../../semantic/style-chain.js";
export declare function normalizeInspectorColorValue(value: string | null): string | null;
export declare function resolveColorSyntaxValue(resolvedTarget: PropertyTargetResolution | null, keys: readonly string[], currentValue: string | null, colorAliases: ReadonlyMap<string, string>, styleChain?: readonly StyleChainEntry[]): string | null;
export declare function collectInspectorColorAliases(source: string): ReadonlyMap<string, string>;
export declare function parseInspectorColorletStatement(source: string, startIndex: number): {
    name: string;
    value: string;
    nextIndex: number;
} | null;
export declare function parseInspectorDefineColorStatement(source: string, startIndex: number): {
    name: string;
    value: string;
    nextIndex: number;
} | null;
export declare function readInspectorBraceGroup(source: string, startIndex: number): {
    value: string;
    nextIndex: number;
} | null;
export declare function normalizeInspectorDeclaredColorName(raw: string): string | null;
export declare function skipInspectorWhitespace(source: string, startIndex: number): number;
export declare function colorOptionsForValue(value: string | null): string[];
