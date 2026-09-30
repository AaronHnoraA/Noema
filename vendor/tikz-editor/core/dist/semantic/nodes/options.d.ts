import type { PathOptionItem } from "../../ast/types.js";
import type { OptionListAst } from "../../options/types.js";
import { type ProvenanceOptionList, type SemanticContext } from "../context.js";
import type { ResolvedStyle } from "../types.js";
import type { NodeLayer, NodeShape } from "./types.js";
import type { WorldTransform } from "../../coords/transforms.js";
export declare function withDefaultNodePosition(options: OptionListAst | undefined, defaultPos: number | undefined): OptionListAst | undefined;
export declare function resolveNodeStyle(options: PathOptionItem["options"] | undefined, baseStyle: ResolvedStyle, context: SemanticContext, transformScale?: number): ResolvedStyle;
export declare function resolveNodeOptionScale(options: PathOptionItem["options"] | undefined, baseStyle: ResolvedStyle, context: SemanticContext): number;
export declare function resolveNodeOptionTransform(options: PathOptionItem["options"] | undefined, baseStyle: ResolvedStyle, context: SemanticContext): WorldTransform;
export type EveryShapeNodeStyleBucketKey = "everyRectangleNodeStyles" | "everyCircleNodeStyles" | "everyDiamondNodeStyles" | "everyTrapeziumNodeStyles" | "everyIsoscelesTriangleNodeStyles" | "everyKiteNodeStyles" | "everyDartNodeStyles" | "everyCircularSectorNodeStyles" | "everyCylinderNodeStyles" | "everyCloudNodeStyles" | "everyStarburstNodeStyles" | "everySignalNodeStyles" | "everyTapeNodeStyles" | "everyRectangleCalloutNodeStyles" | "everyEllipseCalloutNodeStyles" | "everyCloudCalloutNodeStyles" | "everySingleArrowNodeStyles" | "everyDoubleArrowNodeStyles";
export type EveryShapeNodeStyleBuckets<T> = Record<EveryShapeNodeStyleBucketKey, T[]>;
export declare function resolveEveryShapeNodeStyleLists<T>(shape: NodeShape, buckets: EveryShapeNodeStyleBuckets<T>): T[];
export declare function resolveEffectiveNodeOptions(params: {
    statementOptions: OptionListAst | undefined;
    nodeOptions: OptionListAst | undefined;
    everyNodeStyles: NodeStyleOptionList[];
    everyFitStyles?: NodeStyleOptionList[];
    applyEveryFitStyles?: boolean;
    syntheticOptions?: OptionListAst[];
} & EveryShapeNodeStyleBuckets<NodeStyleOptionList>): OptionListAst | undefined;
export declare function expandNodeOptionsForShape(options: OptionListAst | undefined, context: SemanticContext): OptionListAst | undefined;
type NodeStyleOptionList = OptionListAst | ProvenanceOptionList;
export declare function computeTransformScale(transform: {
    a: number;
    b: number;
    c: number;
    d: number;
}): number;
export declare function computeTransformRotation(transform: {
    a: number;
    b: number;
    c: number;
    d: number;
}): number;
export declare function resolveNodeShape(options: PathOptionItem["options"] | undefined): NodeShape;
export declare function resolveNodeAnchor(options: PathOptionItem["options"] | undefined): string;
export declare function resolveNodeLayer(options: PathOptionItem["options"] | undefined, context: SemanticContext): NodeLayer;
export {};
