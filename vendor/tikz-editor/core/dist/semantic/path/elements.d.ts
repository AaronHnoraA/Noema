import type { WorldTransform } from "../../coords/transforms.js";
import type { WorldPoint } from "../../coords/points.js";
import type { ResolvedStyle, SceneCircle, SceneElement, SceneEllipse, ScenePath, ScenePathCommand, ScenePathShapeHint } from "../types.js";
import type { StyleChainEntry } from "../style-chain.js";
export declare function makePath(sourceId: string, itemId: string, style: ResolvedStyle, styleChain: StyleChainEntry[], span: {
    from: number;
    to: number;
}, shapeHint?: ScenePathShapeHint | null): ScenePath;
export declare function ensurePathForSubpath(activePath: ScenePath | null, sourceId: string, itemId: string, style: ResolvedStyle, styleChain: StyleChainEntry[], span: {
    from: number;
    to: number;
}, shapeHint?: ScenePathShapeHint | null): ScenePath;
export declare function markPathShapeHint(path: ScenePath, hint: ScenePathShapeHint): void;
export declare function appendRectangleSubpath(commands: ScenePathCommand[], from: WorldPoint, to: WorldPoint, roundedCorners?: number | null, transform?: WorldTransform): void;
export declare function appendCircleSubpath(commands: ScenePathCommand[], center: WorldPoint, radius: number): void;
export declare function appendEllipseSubpath(commands: ScenePathCommand[], center: WorldPoint, rx: number, ry: number, rotation: number): void;
export declare function hasDrawablePathSegments(path: ScenePath): boolean;
export declare function dropUndrawnActivePath(path: ScenePath | null): ScenePath | null;
export declare function flushDrawableActivePath(elements: SceneElement[], path: ScenePath | null): ScenePath | null;
export declare function makeRectangleElement(sourceId: string, itemId: string, from: WorldPoint, to: WorldPoint, style: ResolvedStyle, styleChain: StyleChainEntry[], span: {
    from: number;
    to: number;
}, roundedCorners?: number | null, transform?: WorldTransform): ScenePath;
export declare function makeCircleElement(sourceId: string, center: WorldPoint, radius: number, style: ResolvedStyle, styleChain: StyleChainEntry[], span: {
    from: number;
    to: number;
}): SceneCircle;
export declare function makeEllipseElement(sourceId: string, center: WorldPoint, rx: number, ry: number, style: ResolvedStyle, styleChain: StyleChainEntry[], span: {
    from: number;
    to: number;
}, rotation?: number): SceneEllipse;
