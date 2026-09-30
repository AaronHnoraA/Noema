import { type EditHandle, type EditHandlePositioningContext } from "../semantic/types.js";
import type { WorldPoint } from "../coords/points.js";
import { type NumberFormatOptions } from "./format.js";
/**
 * Compute a replacement source string for moving a handle to a new world position.
 * Returns null if the rewrite cannot be performed.
 */
export declare function rewriteCoordinate(newWorld: WorldPoint, handle: EditHandle, source: string): string | null;
export declare function supportsUnsupportedCoordinateDetach(handle: EditHandle): boolean;
export declare function rewritePositioningFromContext(newWorld: WorldPoint, ctx: EditHandlePositioningContext, formatOptions?: NumberFormatOptions): string | null;
