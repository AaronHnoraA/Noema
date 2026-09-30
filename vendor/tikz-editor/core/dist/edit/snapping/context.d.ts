import { type BuildSnapContextInput, type SnapContext, type SnapSettings, type SnapSettingsPatch } from "./types.js";
export declare function resolveSnapSettings(patch?: SnapSettingsPatch, base?: SnapSettings): SnapSettings;
export declare function buildSnapContext(input: BuildSnapContextInput): SnapContext;
