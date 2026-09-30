import type { OptionEntry, OptionListAst } from "../../options/types.js";
import type { StyleSourceRef } from "../style-chain.js";
export type CustomStyleRegistry = Map<string, CustomStyleLayer[]>;
type CustomStyleDefinitionKind = "style" | "append" | "prefix";
export type CustomStyleLayer = {
    options: OptionListAst;
    sourceRef: StyleSourceRef;
};
export type CustomStyleDefinition = {
    name: string;
    kind: CustomStyleDefinitionKind;
};
export type CustomStyleInvocation = {
    name: string;
    layers: CustomStyleLayer[];
};
export declare function createDefaultCustomStyleRegistry(): CustomStyleRegistry;
export declare function cloneCustomStyleRegistry(registry: CustomStyleRegistry): CustomStyleRegistry;
export declare function walkOptionEntriesWithCustomStyles(optionLists: OptionListAst[], customStyles: CustomStyleRegistry, onEntry: (entry: OptionEntry) => void, diagnostics: string[], sourceRef?: StyleSourceRef): void;
export declare function applyCustomStyleDefinition(customStyles: CustomStyleRegistry, styleName: string, kind: CustomStyleDefinitionKind, optionList: OptionListAst, sourceRef?: StyleSourceRef): void;
export declare function resolveCustomStyleInvocation(entry: OptionEntry, customStyles: CustomStyleRegistry): CustomStyleInvocation | null;
export declare function parseCustomStyleDefinition(key: string): CustomStyleDefinition | null;
export declare function normalizeCustomStyleName(raw: string): string;
export {};
