import type { WorldPoint } from "../../coords/points.js";
import type { ResolvedStyle, SceneElement, ScenePath } from "../types.js";
import type { StyleChainEntry } from "../style-chain.js";
import type { FeatureMarkFn } from "./types.js";
export type EllipseGeometry = {
    rx: number;
    ry: number;
    rotation: number;
};
export type CircleOrEllipseGeometry = {
    kind: "circle";
    radius: number;
} | ({
    kind: "ellipse";
} & EllipseGeometry);
export declare function transformCircleGeometry(radius: number, transform: {
    a: number;
    b: number;
    c: number;
    d: number;
}): CircleOrEllipseGeometry;
export declare function transformEllipseGeometry(rx: number, ry: number, rotation: number, transform: {
    a: number;
    b: number;
    c: number;
    d: number;
}): EllipseGeometry;
export declare function emitCircleOrEllipse(params: {
    geometry: CircleOrEllipseGeometry;
    center: WorldPoint;
    statementId: string;
    itemId: string;
    span: {
        from: number;
        to: number;
    };
    style: ResolvedStyle;
    styleChain: StyleChainEntry[];
    shouldCompoundFilledSubpaths: boolean;
    activePath: ScenePath | null;
    geometryElements: SceneElement[];
    markFeature: FeatureMarkFn;
}): ScenePath | null;
