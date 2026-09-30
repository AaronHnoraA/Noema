import type { WorldPoint, WorldVector } from "../coords/points.js";
import type { ScenePathCommand } from "../semantic/types.js";
export type Frame = {
    point: WorldPoint;
    tangent: WorldVector;
    normal: WorldVector;
};
export type DrawableCommand = Extract<ScenePathCommand, {
    kind: "L" | "C" | "A";
}>;
type ArcGeometry = {
    cx: number;
    cy: number;
    rx: number;
    ry: number;
    phi: number;
    xAxisRotation: number;
    startAngle: number;
    deltaAngle: number;
};
export type PathSegment = {
    kind: "L";
    from: WorldPoint;
    to: WorldPoint;
    command: Extract<ScenePathCommand, {
        kind: "L";
    }>;
    length: number;
} | {
    kind: "C";
    from: WorldPoint;
    to: WorldPoint;
    command: Extract<ScenePathCommand, {
        kind: "C";
    }>;
    length: number;
} | {
    kind: "A";
    from: WorldPoint;
    to: WorldPoint;
    command: Extract<ScenePathCommand, {
        kind: "A";
    }>;
    length: number;
    arc: ArcGeometry | null;
};
export declare function clonePoint(point: WorldPoint): WorldPoint;
export declare function addPoint(left: WorldPoint, right: WorldVector): WorldPoint;
export declare function subtractPoint(left: WorldPoint, right: WorldPoint): WorldVector;
export declare function scaleVector(vector: WorldVector, factor: number): WorldVector;
export declare function lengthOfVector(vector: WorldVector): number;
export declare function normalizeVector(vector: WorldVector): WorldVector;
export declare function perpendicular(vector: WorldVector): WorldVector;
export declare function clonePathCommand(command: ScenePathCommand): ScenePathCommand;
export declare function splitPathIntoSubpaths(commands: ScenePathCommand[]): ScenePathCommand[][];
export declare function flattenSubpaths(subpaths: ScenePathCommand[][]): ScenePathCommand[];
export declare function hasDrawablePathCommands(commands: ScenePathCommand[]): boolean;
export declare function commandsToSegments(commands: ScenePathCommand[]): PathSegment[];
export declare function totalSegmentLength(segments: PathSegment[]): number;
export declare function sampleFrameFromStartExtrapolated(segments: PathSegment[], distance: number): Frame | null;
export declare function sampleFrameFromEndExtrapolated(segments: PathSegment[], distance: number): Frame | null;
export declare function samplePointFromStartExtrapolated(segments: PathSegment[], distance: number): WorldPoint | null;
export declare function commandFromSegment(segment: PathSegment): DrawableCommand;
export declare function sliceSegment(segment: PathSegment, startDistance: number, endDistance: number): PathSegment | null;
export {};
