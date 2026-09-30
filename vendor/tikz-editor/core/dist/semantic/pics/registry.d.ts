import type { PicOperationItem, Span } from "../../ast/types.js";
import type { OptionListAst } from "../../options/types.js";
import type { StyleSourceRef } from "../style-chain.js";
type PicCodeLayer = "normal" | "background" | "foreground";
export type PicDefinition = {
    name: string;
    codeRaw: string;
    codeSpan?: Span;
    sourceRef: StyleSourceRef;
    parameterized: boolean;
    codeLayer: PicCodeLayer;
};
export type PicDefinitionRegistry = Map<string, PicDefinition>;
export type ResolvedPicCode = {
    kind: "found";
    codeRaw: string;
    codeSpan?: Span;
    sourceRef: StyleSourceRef;
    source: "definition" | "inline";
    parameterized: boolean;
    unresolvedParameters: boolean;
    codeLayer: PicCodeLayer;
} | {
    kind: "not-found";
    reason: string;
};
export declare function createDefaultPicDefinitionRegistry(): PicDefinitionRegistry;
export declare function clonePicDefinitionRegistry(registry: PicDefinitionRegistry): PicDefinitionRegistry;
export declare function applyPicDefinitionsFromOptionLists(registry: PicDefinitionRegistry, optionLists: readonly OptionListAst[], sourceRef: StyleSourceRef): void;
export declare function resolvePicCode(item: PicOperationItem, registry: PicDefinitionRegistry): ResolvedPicCode;
export declare function isPicDefinitionOptionKey(key: string): boolean;
export declare function isPicCodeOptionKey(key: string): boolean;
export declare function normalizePicName(raw: string): string;
export {};
