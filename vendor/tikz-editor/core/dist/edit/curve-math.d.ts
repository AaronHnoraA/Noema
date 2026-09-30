import type { WorldPoint } from "../coords/points.js";
/**
 * Find the closest point on a line segment to a given point.
 */
export declare function closestPointOnLine(p: WorldPoint, a: WorldPoint, b: WorldPoint): {
    t: number;
    point: WorldPoint;
};
/**
 * Evaluate a cubic Bezier at parameter t.
 */
export declare function evalCubic(t: number, c0: WorldPoint, c1: WorldPoint, c2: WorldPoint, c3: WorldPoint): WorldPoint;
/**
 * Find the closest point on a cubic Bezier to a given point.
 * Uses iterative subdivision for robust results.
 */
export declare function closestPointOnCubic(p: WorldPoint, c0: WorldPoint, c1: WorldPoint, c2: WorldPoint, c3: WorldPoint): {
    t: number;
    point: WorldPoint;
};
/**
 * Split a cubic Bezier at parameter t using de Casteljau subdivision.
 * Returns control points for the two resulting cubics.
 */
export declare function subdivideCubicAt(t: number, c0: WorldPoint, c1: WorldPoint, c2: WorldPoint, c3: WorldPoint): {
    left: [WorldPoint, WorldPoint, WorldPoint, WorldPoint];
    right: [WorldPoint, WorldPoint, WorldPoint, WorldPoint];
};
