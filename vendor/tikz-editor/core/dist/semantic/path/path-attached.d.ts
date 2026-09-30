import { type WorldPoint, type WorldVector } from "../../coords/points.js";
import type { OptionListAst } from "../../options/types.js";
import type { StyleChainEntry } from "../style-chain.js";
import type { ScenePathAttachment } from "../types.js";
import type { PlacementSegment } from "./types.js";
export type PathPositionPreset = "at start" | "very near start" | "near start" | "midway" | "near end" | "very near end" | "at end";
export declare const PATH_POSITION_PRESETS: ReadonlyArray<{
    key: PathPositionPreset;
    t: number;
    label: string;
}>;
export declare function normalizePathPosition(position: number): number;
export declare function resolvePathPositionFraction(options: OptionListAst | undefined): number | null;
export declare function resolvePathPositionPreset(position: number, segment: PlacementSegment | null, options?: {
    normalizedThreshold?: number;
    worldThresholdPt?: number;
}): {
    preset: PathPositionPreset | null;
    snappedT: number;
};
export declare function approximatePlacementSegmentLength(segment: PlacementSegment): number;
export declare function pointAtPlacementSegment(segment: PlacementSegment, t: number): WorldPoint;
export declare function tangentAtPlacementSegment(segment: PlacementSegment, t: number): WorldVector;
export declare function closestPointOnPlacementSegment(segment: PlacementSegment, point: WorldPoint): {
    t: number;
    point: WorldPoint;
};
export declare function resolvePathAttachedNodeRegime(options: OptionListAst | undefined, styleChain?: readonly StyleChainEntry[]): ScenePathAttachment["regime"];
export declare function resolvePathAttachedNodeSloped(options: OptionListAst | undefined, styleChain?: readonly StyleChainEntry[]): boolean;
export declare function resolveExplicitDirectionFromPoint(point: WorldPoint, anchor: WorldPoint, family: "cardinal-diagonal" | "base" | "mid"): string;
export declare function resolveDraggedPathAttachedNodeDirection(anchor: WorldPoint, point: WorldPoint, regime: Extract<ScenePathAttachment["regime"], {
    kind: "explicit-direction";
}>, options?: {
    axisThreshold?: number;
}): string;
export declare function resolvePathAttachedDirectionUnit(direction: string): WorldPoint;
