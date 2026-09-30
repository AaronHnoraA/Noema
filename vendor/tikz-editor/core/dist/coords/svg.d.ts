import type { SvgBounds, SvgPoint, WorldBounds, WorldPoint } from "./points.js";
import type { WorldToSvgTransform, WorldTransform } from "./transforms.js";
export type SvgViewBoxLike = Pick<{
    y: number;
    height: number;
}, "y" | "height">;
export declare function worldToSvgY(worldY: WorldPoint["y"], viewBox: SvgViewBoxLike): SvgPoint["y"];
export declare function worldToSvgPoint(point: WorldPoint, viewBox: SvgViewBoxLike): SvgPoint;
export declare function svgToWorldPoint(point: SvgPoint, viewBox: SvgViewBoxLike): WorldPoint;
export declare function worldToSvgBounds(bounds: WorldBounds, viewBox: SvgViewBoxLike): SvgBounds;
export declare function mapWorldTransformToSvgTransform(matrix: WorldTransform, viewBox: SvgViewBoxLike): WorldToSvgTransform;
