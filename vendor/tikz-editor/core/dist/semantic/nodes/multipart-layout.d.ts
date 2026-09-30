import { type WorldPoint } from "../../coords/points.js";
import type { OptionListAst } from "../../options/types.js";
import { type SemanticContext } from "../context.js";
import type { ResolvedStyle } from "../types.js";
import { resolveNodeLayout } from "./layout.js";
import { type NodePartText } from "./multipart.js";
import { type TwoPartShapeSizingInput } from "./shape-geometry.js";
import type { NodeLayout, NodeShape } from "./types.js";
export type RectangleSplitSegment = {
    center: WorldPoint;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    width: number;
    height: number;
};
export type RectangleSplitPartLayout = {
    text: string;
    layout: ReturnType<typeof resolveNodeLayout>;
    metricWidth: number;
    metricHeight: number;
};
export type RectangleSplitPartAlign = "left" | "right" | "center" | "top" | "bottom" | "base";
export type RectangleSplitLayoutGeometry = {
    horizontal: boolean;
    width: number;
    height: number;
    textStyle: ResolvedStyle;
    parts: RectangleSplitPartLayout[];
    segments: RectangleSplitSegment[];
    partAlignments: RectangleSplitPartAlign[];
};
export declare function mergeOptionLists(lists: Array<OptionListAst | undefined>): OptionListAst | undefined;
export declare function resolveTwoPartSplitTextPosition(params: {
    nodeShape: NodeShape;
    nodeLayout: NodeLayout;
    partLayout: NodeLayout;
    center: WorldPoint;
    anchor: "lower" | "text";
    options: OptionListAst | undefined;
    lineWidth: number;
}): WorldPoint;
export declare function resolveCircleSolidusHorizontalTextOffset(layout: NodeLayout, lineWidth: number): number;
export declare function resolveCircleSolidusVerticalTextOffset(layout: NodeLayout, lineWidth: number): number;
export type TwoPartShapeVisual = {
    width: number;
    height: number;
    radius: number;
};
export declare function resolveTwoPartShapeSizing(params: {
    nodeShape: NodeShape;
    rawNodeParts: NodePartText[];
    options: OptionListAst | undefined;
    style: ResolvedStyle;
    textMode: "text" | "math";
    context: SemanticContext;
    baseLayout: NodeLayout;
}): TwoPartShapeSizingInput | null;
export declare function resolveTwoPartShapeVisual(shape: NodeShape, sizing: TwoPartShapeSizingInput, aspect: number): TwoPartShapeVisual;
export declare function resolveRectangleSplitLayoutGeometry(params: {
    rawNodeParts: NodePartText[];
    options: OptionListAst | undefined;
    style: ResolvedStyle;
    textMode: "text" | "math";
    context: SemanticContext;
    baseLayout: ReturnType<typeof resolveNodeLayout>;
}): RectangleSplitLayoutGeometry;
export declare function resolveRectangleSplitPartTextPosition(params: {
    splitLayout: RectangleSplitLayoutGeometry;
    index: number;
    center: WorldPoint;
}): WorldPoint;
export declare function resolveRectangleSplitUseCustomFill(options: OptionListAst | undefined): boolean;
export declare function resolveRectangleSplitDrawSplits(options: OptionListAst | undefined): boolean;
export declare function resolveRectangleSplitPartFills(options: OptionListAst | undefined, context: SemanticContext, consumerStatementId: string, currentColor: string): string[];
