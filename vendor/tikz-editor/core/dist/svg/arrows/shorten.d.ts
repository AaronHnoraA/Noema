import type { ScenePathCommand } from "../../semantic/types.js";
export type ShortenSubpathResult = {
    commands: ScenePathCommand[];
    appliedStartShortening: number;
    appliedEndShortening: number;
    originalLength: number;
};
export declare function shortenOpenSubpath(subpath: ScenePathCommand[], requestedStartShortening: number, requestedEndShortening: number): ShortenSubpathResult;
