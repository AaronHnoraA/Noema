import type { EditActionResultLike } from "./result-types.js";
import { type EditParseOptions, type PropertyWriteInteractionMode } from "./parse-options.js";
import type { SetPropertyAction } from "./actions/set-property.js";
export type CleanupCertificate = {
    accepted: true;
    reason: string;
    candidate: string;
} | {
    accepted: false;
    reason: string;
    candidate: string;
};
export type PropertyWriteRequest = {
    source: string;
    action: SetPropertyAction;
    parseOptions?: EditParseOptions;
    mode?: PropertyWriteInteractionMode;
};
export type PropertyWritePlan = {
    conservative: EditActionResultLike;
    selected: EditActionResultLike;
    certificates: CleanupCertificate[];
};
export declare function applyPlannedSetPropertyAction(source: string, action: SetPropertyAction, parseOptions?: EditParseOptions): EditActionResultLike;
export declare const PROPERTY_WRITE_CLEANUP_NOOP_REASON = "Property write cleanup would not change the source.";
export declare function cleanupIdiomaticPropertyWrites(source: string, parseOptions?: EditParseOptions, elementIds?: readonly string[]): EditActionResultLike;
export declare function planPropertyWrite(request: PropertyWriteRequest): PropertyWritePlan;
