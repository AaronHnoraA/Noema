import type { OptionListAst } from "../options/types.js";
import type { PropertyTarget, PropertyTargetOptionsFormat } from "./property-target.js";
import type { SourcePatch } from "./types.js";
import { normalizeOptionKey as normalizeSharedOptionKey } from "./option-key.js";
export type OptionMutation = {
    kind: "set";
    value: string;
} | {
    kind: "remove";
};
export type OptionMutationApplyResult = {
    source: string;
    patch: SourcePatch;
};
type OptionSerializationContext = {
    bareColorKey: "draw" | "fill" | null;
};
export declare function applyOptionMutationsToTarget(source: string, target: PropertyTarget, mutations: ReadonlyMap<string, OptionMutation>): OptionMutationApplyResult | null;
export declare function rewriteOptionListMutations(options: OptionListAst, mutations: ReadonlyMap<string, OptionMutation>, serializationContext?: OptionSerializationContext, format?: PropertyTargetOptionsFormat): string;
export declare const normalizeOptionKey: typeof normalizeSharedOptionKey;
export declare function serializeOptionEntry(key: string, value: string, serializationContext?: OptionSerializationContext): string;
export {};
