import type { SvgBounds, SvgPoint } from "../coords/points.js";
import type { SvgTransform } from "../coords/transforms.js";
import type { ScenePathCommand } from "../semantic/types.js";
import type { SvgViewBox } from "./types.js";
export declare function computeSvgPathBounds(commands: ScenePathCommand[], viewBox: Pick<SvgViewBox, "y" | "height">): SvgBounds | null;
export declare function includeSvgArcBounds(args: {
    start: SvgPoint;
    end: SvgPoint;
    rx: number;
    ry: number;
    xAxisRotation: number;
    largeArc: boolean;
    sweep: 0 | 1;
    includePoint: (point: SvgPoint) => void;
}): void;
export declare function computeSvgEllipseBounds(cx: number, cy: number, rx: number, ry: number, rotation: number): SvgBounds;
export declare function transformSvgBounds(bounds: SvgBounds, transform: SvgTransform): SvgBounds;
