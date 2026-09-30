import type { FeatureUsage, SceneElement } from "./types.js";
export type InferRequiredTikzLibrariesInput = {
    featureUsage: FeatureUsage;
    elements: readonly SceneElement[];
};
export declare function inferRequiredTikzLibraries(input: InferRequiredTikzLibrariesInput): string[];
