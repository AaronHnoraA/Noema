import type { SourcePatch } from "./types.js";
type PatchValidationFailure = "invalid-span-order" | "out-of-bounds" | "overlapping";
export type ApplySourcePatchesResult = {
    kind: "success";
    source: string;
} | {
    kind: "invalid";
    reason: PatchValidationFailure;
};
/**
 * Applies source patches whose old spans are interpreted against the same
 * original source document.
 */
export declare function applySourcePatches(source: string, patches: readonly SourcePatch[]): ApplySourcePatchesResult;
/**
 * Validates that a patch list represents the transition `previous -> next`
 * when all old spans are interpreted against `previous`.
 */
export declare function patchesMatchSourceTransition(previous: string, next: string, patches: readonly SourcePatch[]): boolean;
export {};
