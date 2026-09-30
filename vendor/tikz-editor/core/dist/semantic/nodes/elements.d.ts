import type { PathOptionItem } from "../../ast/types.js";
import type { NodeTextRenderInfo } from "../../text/types.js";
import type { WorldPoint } from "../../coords/points.js";
import type { ResolvedStyle, SceneAdornment, SceneCircle, SceneEllipse, ScenePath, SceneText } from "../types.js";
import type { StyleChainEntry } from "../style-chain.js";
import { type SignalDirection, type TapeBendStyle, type TwoPartShapeSizingInput } from "./shape-geometry.js";
export declare function makeCircleElement(sourceId: string, center: WorldPoint, radius: number, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[], adornment?: SceneAdornment): SceneCircle;
export declare function makeTextElement(sourceId: string, itemId: string, position: WorldPoint, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, text: string, textBlockWidth?: number, textBlockHeight?: number, nodeVisualWidth?: number, nodeVisualHeight?: number, textRenderInfo?: NodeTextRenderInfo, rotation?: number, styleChain?: StyleChainEntry[], textSourceSpan?: {
    from: number;
    to: number;
}, textHasFixedWidth?: boolean, adornment?: SceneAdornment): SceneText;
export declare function resolveNodeBoxPaintMode(options: PathOptionItem["options"] | undefined): {
    draw: boolean;
    fill: boolean;
};
export declare function applyNodeBoxPaintMode(style: ResolvedStyle, paintMode: {
    draw: boolean;
    fill: boolean;
}): ResolvedStyle;
export declare function makeNodeBoxElement(sourceId: string, itemId: string, center: WorldPoint, width: number, height: number, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[], adornment?: SceneAdornment): ScenePath;
export declare function makeNodeEllipseElement(sourceId: string, itemId: string, center: WorldPoint, width: number, height: number, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[], adornment?: SceneAdornment): SceneEllipse;
export declare function makeNodeDiamondElement(sourceId: string, itemId: string, center: WorldPoint, width: number, height: number, aspect: number, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[]): ScenePath;
export declare function makeNodeDiamondSizingElement(sourceId: string, itemId: string, center: WorldPoint, naturalWidth: number, naturalHeight: number, minimumWidth: number, minimumHeight: number, aspect: number, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[]): ScenePath;
export declare function makeNodeDiamondSplitElement(sourceId: string, itemId: string, center: WorldPoint, sizing: TwoPartShapeSizingInput, aspect: number, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[]): ScenePath;
export declare function makeNodeRoundedRectangleElement(sourceId: string, itemId: string, center: WorldPoint, naturalWidth: number, naturalHeight: number, minimumWidth: number, minimumHeight: number, textBlockWidth: number, textBlockHeight: number, innerXSep: number, innerYSep: number, arcLength: number, westArc: "convex" | "concave" | "none", eastArc: "convex" | "concave" | "none", style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[]): ScenePath;
export declare function makeNodeChamferedRectangleElement(sourceId: string, itemId: string, center: WorldPoint, naturalWidth: number, naturalHeight: number, minimumWidth: number, minimumHeight: number, chamferX: number, chamferY: number, chamferAngle: number, cornersRaw: string, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[]): ScenePath;
export declare function makeNodeLineElement(sourceId: string, itemId: string, from: WorldPoint, to: WorldPoint, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[]): ScenePath;
export declare function makeNodeMagnifyingHandleElement(sourceId: string, itemId: string, center: WorldPoint, radius: number, angleDegrees: number, aspect: number, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[]): ScenePath;
export declare function makeNodeTrapeziumElement(sourceId: string, itemId: string, center: WorldPoint, naturalWidth: number, naturalHeight: number, minimumWidth: number, minimumHeight: number, leftAngle: number, rightAngle: number, rotation: number, stretches: boolean, stretchesBody: boolean, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[]): ScenePath;
export declare function makeNodeIsoscelesTriangleElement(sourceId: string, itemId: string, center: WorldPoint, naturalWidth: number, naturalHeight: number, minimumWidth: number, minimumHeight: number, apexAngle: number, rotation: number, stretches: boolean, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[]): ScenePath;
export declare function makeNodeKiteElement(sourceId: string, itemId: string, center: WorldPoint, naturalWidth: number, naturalHeight: number, minimumWidth: number, minimumHeight: number, upperVertexAngle: number, lowerVertexAngle: number, rotation: number, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[]): ScenePath;
export declare function makeNodeDartElement(sourceId: string, itemId: string, center: WorldPoint, naturalWidth: number, naturalHeight: number, minimumWidth: number, minimumHeight: number, tipAngle: number, tailAngle: number, rotation: number, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[]): ScenePath;
export declare function makeNodeSemicircleElement(sourceId: string, itemId: string, center: WorldPoint, naturalWidth: number, naturalHeight: number, minimumWidth: number, minimumHeight: number, rotation: number, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[]): ScenePath;
export declare function makeNodeCircularSectorElement(sourceId: string, itemId: string, center: WorldPoint, naturalWidth: number, naturalHeight: number, minimumWidth: number, minimumHeight: number, sectorAngle: number, rotation: number, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[]): ScenePath;
export declare function makeNodeRegularPolygonElement(sourceId: string, itemId: string, center: WorldPoint, naturalWidth: number, naturalHeight: number, minimumWidth: number, minimumHeight: number, sides: number, rotation: number, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[]): ScenePath;
export declare function makeNodeCylinderElement(sourceId: string, itemId: string, center: WorldPoint, naturalWidth: number, naturalHeight: number, minimumWidth: number, minimumHeight: number, innerYSep: number, aspect: number, rotation: number, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[]): ScenePath;
export declare function makeNodeStarElement(sourceId: string, itemId: string, center: WorldPoint, naturalWidth: number, naturalHeight: number, minimumWidth: number, minimumHeight: number, points: number, ratio: number, pointHeightPt: number, usesRatio: boolean, rotation: number, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[]): ScenePath;
export declare function makeNodeCloudElement(sourceId: string, itemId: string, center: WorldPoint, naturalWidth: number, naturalHeight: number, minimumWidth: number, minimumHeight: number, puffs: number, puffArc: number, aspect: number, ignoresAspect: boolean, rotation: number, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[]): ScenePath;
export declare function makeNodeStarburstElement(sourceId: string, itemId: string, center: WorldPoint, naturalWidth: number, naturalHeight: number, minimumWidth: number, minimumHeight: number, points: number, pointHeightPt: number, randomSeed: number, rotation: number, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[]): ScenePath;
export declare function makeNodeSignalElement(sourceId: string, itemId: string, center: WorldPoint, naturalWidth: number, naturalHeight: number, minimumWidth: number, minimumHeight: number, pointerAngle: number, toSides: SignalDirection[], fromSides: SignalDirection[], style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[]): ScenePath;
export declare function makeNodeTapeElement(sourceId: string, itemId: string, center: WorldPoint, naturalWidth: number, naturalHeight: number, minimumWidth: number, minimumHeight: number, bendTop: TapeBendStyle, bendBottom: TapeBendStyle, bendHeightPt: number, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[]): ScenePath;
export declare function makeNodeRectangleCalloutElement(sourceId: string, itemId: string, center: WorldPoint, naturalWidth: number, naturalHeight: number, minimumWidth: number, minimumHeight: number, pointerOffset: WorldPoint, pointerWidthPt: number, pointerIsAbsolute: boolean, pointerShortenPt: number, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[]): ScenePath;
export declare function makeNodeEllipseCalloutElement(sourceId: string, itemId: string, center: WorldPoint, naturalWidth: number, naturalHeight: number, minimumWidth: number, minimumHeight: number, pointerOffset: WorldPoint, pointerArc: number, pointerIsAbsolute: boolean, pointerShortenPt: number, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[]): ScenePath;
export declare function makeNodeCloudCalloutElement(sourceId: string, itemId: string, center: WorldPoint, naturalWidth: number, naturalHeight: number, minimumWidth: number, minimumHeight: number, puffs: number, puffArc: number, aspect: number, ignoresAspect: boolean, rotation: number, pointerOffset: WorldPoint, pointerStartSizeRaw: string, pointerEndSizeRaw: string, pointerSegments: number, pointerIsAbsolute: boolean, pointerShortenPt: number, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[]): ScenePath;
export declare function makeNodeSingleArrowElement(sourceId: string, itemId: string, center: WorldPoint, naturalWidth: number, naturalHeight: number, minimumWidth: number, minimumHeight: number, tipAngle: number, headExtendPt: number, headIndentPt: number, rotation: number, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[]): ScenePath;
export declare function makeNodeDoubleArrowElement(sourceId: string, itemId: string, center: WorldPoint, naturalWidth: number, naturalHeight: number, minimumWidth: number, minimumHeight: number, tipAngle: number, headExtendPt: number, headIndentPt: number, rotation: number, style: ResolvedStyle, span: {
    from: number;
    to: number;
}, styleChain?: StyleChainEntry[]): ScenePath;
