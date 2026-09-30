import { cm } from "../coords/scalars.js";
import { sourceCmPoint } from "../coords/points.js";
import { ptToCm } from "../coords/source.js";
import { worldToFrameLocal, worldVectorToFrameLocal } from "../coords/frame.js";
/**
 * Convert a world-space position to local (pre-transform) coordinates.
 * Returns null if the transform is not invertible.
 */
export function worldToFrameLocalPoint(world, transform) {
    return worldToFrameLocal(world, transform);
}
/**
 * Convert a world-space delta to a local-space delta (excludes translation).
 * Returns null if the transform is not invertible.
 */
export function worldVectorToFrameLocalPoint(delta, transform) {
    return worldVectorToFrameLocal(delta, transform);
}
/**
 * Convert local coordinates (TeX points) to source units (cm).
 */
export function frameLocalPtToSourceCmPoint(local) {
    return sourceCmPoint(cm(ptToCm(local.x)), cm(ptToCm(local.y)));
}
export const worldToLocal = worldToFrameLocalPoint;
export const worldDeltaToLocalDelta = worldVectorToFrameLocalPoint;
export const localToSourceUnits = frameLocalPtToSourceCmPoint;
